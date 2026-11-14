/**
 * Real iPhone wiring: expo-sqlite, expo-file-system (legacy API), expo-crypto,
 * and Supabase Auth for the signed-in player's access token.
 * Typechecked against the installed Expo SDK by `npm install && npm run
 * typecheck` inside mobile/ (the laptop-wide typecheck covers only the core).
 */
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';
import { AppState } from 'react-native';
import { createPerspectiveBackend, type PerspectiveBackend } from '../core';
import type { AuthPort, FileStore, Platform, SqlDatabase, SqlValue } from '../core/ports';

/**
 * Every SQL call goes through one JS FIFO. expo-sqlite 16 runs its async
 * functions on a concurrent native queue, so two statements in flight at once
 * can step in parallel, and `changes`/`lastInsertRowId` (read connection-wide
 * after the step) can belong to the other statement. One call at a time makes
 * each result belong to its own statement. Each call is a short single
 * statement, so the queue never holds tagging up behind network work.
 */
async function openSql(name: string): Promise<SqlDatabase> {
  const db = await SQLite.openDatabaseAsync(name);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op);
    tail = run.catch(() => undefined);
    return run;
  };
  const sql: SqlDatabase = {
    exec: (source) => serial(() => db.execAsync(source)),
    run: (source, params: SqlValue[] = []) =>
      serial(async () => {
        // One step in one bridge call; a write without RETURNING halts and commits on it.
        const { changes, lastInsertRowId } = await db.runAsync(source, params);
        return { changes, lastInsertRowId };
      }),
    all: <T>(source: string, params: SqlValue[] = []) => serial(() => db.getAllAsync<T>(source, params)),
    first: <T>(source: string, params: SqlValue[] = []) => serial(() => db.getFirstAsync<T>(source, params)),
    // withTransactionAsync's BEGIN/work/COMMIT, but through the FIFO like everything else.
    // Still not exclusive (see SqlDatabase.transaction): only init-time migrations use it.
    async transaction(work) {
      try {
        await sql.exec('BEGIN');
        await work();
        await sql.exec('COMMIT');
      } catch (err) {
        await sql.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => serial(() => db.closeAsync()),
  };
  return sql;
}

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() || null;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() || null;

/**
 * The app's Supabase client, for the sign-in screens (supabase.auth.signIn…,
 * signOut). Null when the build has no EXPO_PUBLIC_SUPABASE_* values: every
 * player is then signed out and nothing uploads. The session persists in
 * AsyncStorage and refreshes itself while the app is in the foreground.
 */
export const supabase: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { storage: AsyncStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    : null;

/** Latest session seen by the auth listener; outlives a refresh that failed for lack of network. */
let lastSession: Session | null = null;
supabase?.auth.onAuthStateChange((_event, session) => {
  lastSession = session;
});

const TOKEN_LOOKUP_MS = 3_000;

const auth: AuthPort = {
  /**
   * Null only when nobody is signed in. A fresh token comes straight from the
   * cached session. Otherwise getSession refreshes it, bounded in time; if
   * that fails (offline), the stale token is returned: the API answers 401
   * and the shots stay pending, which is right for a signed-in player.
   */
  async getAccessToken() {
    if (!supabase) return null;
    if (lastSession?.expires_at && lastSession.expires_at * 1000 > Date.now() + 60_000) return lastSession.access_token;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        supabase.auth.getSession(),
        new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), TOKEN_LOOKUP_MS))),
      ]);
      if (result?.data.session) return result.data.session.access_token;
      if (result && !result.error) return null; // answered: no session stored
    } catch {
      // fall through to the last session seen
    } finally {
      clearTimeout(timer);
    }
    return lastSession?.access_token ?? null;
  },
};

const files: FileStore = {
  documentUri: FileSystem.documentDirectory!,
  cacheUri: FileSystem.cacheDirectory!,
  async info(uri) {
    const i = await FileSystem.getInfoAsync(uri);
    return { exists: i.exists, size: i.exists && !i.isDirectory ? i.size : null };
  },
  async ensureDir(uri) {
    const i = await FileSystem.getInfoAsync(uri);
    if (!i.exists) await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
  },
  move: (from, to) => FileSystem.moveAsync({ from, to }),
  remove: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
  async list(dirUri) {
    const i = await FileSystem.getInfoAsync(dirUri);
    return i.exists && i.isDirectory ? FileSystem.readDirectoryAsync(dirUri) : [];
  },
  freeBytes: () => FileSystem.getFreeDiskStorageAsync(),
  async upload(url, fileUri, { method, headers, timeoutMs }) {
    // uploadAsync with BINARY_CONTENT, through an upload task so a timeout can cancel it.
    const task = FileSystem.createUploadTask(url, fileUri, {
      httpMethod: method,
      headers,
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void task.cancelAsync().catch(() => undefined);
    }, timeoutMs);
    try {
      const res = await task.uploadAsync();
      if (timedOut) throw new Error(`upload timed out after ${timeoutMs} ms`);
      if (!res) throw new Error('upload cancelled');
      return { status: res.status };
    } finally {
      clearTimeout(timer);
    }
  },
  async download(url, destUri, { timeoutMs, maxBytes, onProgress }) {
    let stopped: 'timeout' | 'oversize' | null = null;
    let received = 0;
    // cancelAsync, not pauseAsync: it drops the task without building resume
    // data we never use, and stops progress events. Either way the native
    // delegate resolves downloadAsync with null (NSURLErrorCancelled).
    const stop = (why: 'timeout' | 'oversize') => {
      if (stopped) return;
      stopped = why;
      void job.cancelAsync().catch(() => undefined);
    };
    const job = FileSystem.createDownloadResumable(url, destUri, {}, (p) => {
      received = p.totalBytesWritten;
      // A declared Content-Length over the limit is refused as early as the
      // first progress event, before the rest of the body arrives.
      if (maxBytes !== undefined && (received > maxBytes || p.totalBytesExpectedToWrite > maxBytes)) {
        stop('oversize');
        return;
      }
      onProgress?.(received);
    });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    try {
      // Non-2xx responses still resolve, with the body written to destUri;
      // the core checks `status` and deletes the temp file.
      const res = await job.downloadAsync();
      if (stopped === 'oversize') throw new Error(`exceeded maxBytes (${maxBytes}): received ${received} bytes`);
      if (stopped === 'timeout') throw new Error(`timed out after ${timeoutMs} ms`);
      if (!res) throw new Error('download cancelled');
      return { status: res.status };
    } finally {
      clearTimeout(timer);
    }
  },
};

export async function createExpoPlatform(): Promise<Platform> {
  return {
    db: await openSql('perspective.db'),
    files,
    fetch: (url, init) => fetch(url, init),
    auth,
    newId: () => Crypto.randomUUID(),
    now: () => Date.now(),
  };
}

let started: Promise<PerspectiveBackend> | null = null;

/**
 * App entry: `const backend = await startBackend();` in the root provider.
 *
 * Idempotent. expo-sqlite gives every openDatabaseAsync('perspective.db') the
 * same cached native connection, so two overlapping launches (React StrictMode
 * runs effects twice in development) would interleave their migration
 * transactions on it. On a fresh install, one launch's ROLLBACK could undo the
 * other's tables after it had set user_version. All callers share one launch.
 */
export function startBackend(): Promise<PerspectiveBackend> {
  started ??= launch().catch((err) => {
    started = null;
    throw err;
  });
  return started;
}

async function launch(): Promise<PerspectiveBackend> {
  // Release builds without an API URL get null, so the 3D viewer reports
  // not_configured instead of quietly calling the phone's own localhost (which
  // looks exactly like "API down"). Only development keeps the localhost default.
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim() || null;
  const apiBaseUrl = configured ?? (__DEV__ ? 'http://localhost:3001' : null);
  const backend = await createPerspectiveBackend(await createExpoPlatform(), { apiBaseUrl });

  // Clip sync triggers: at launch, on returning to the foreground, shortly
  // after tagging edits, and on sign-out (which turns pending shots local_only,
  // so nothing waits for whoever signs in next). Fire and forget: syncNow never
  // throws and joins a run already in progress.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const syncSoon = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void backend.clips.syncNow(), 1_500);
  };
  const after =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      const result = await fn(...args);
      syncSoon();
      return result;
    };
  const shots = backend.shots;
  shots.addShot = after(shots.addShot.bind(shots));
  shots.setOutcome = after(shots.setOutcome.bind(shots));
  shots.deleteShot = after(shots.deleteShot.bind(shots));
  const sessions = backend.sessions;
  sessions.deleteSession = after(sessions.deleteSession.bind(sessions));
  sessions.removeVideo = after(sessions.removeVideo.bind(sessions));

  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase?.auth.startAutoRefresh();
      void backend.clips.syncNow();
    } else {
      supabase?.auth.stopAutoRefresh();
    }
  });
  const authListener = supabase?.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') void backend.clips.syncNow();
  });
  void backend.clips.syncNow();

  return {
    ...backend,
    close: async () => {
      started = null;
      clearTimeout(debounce);
      appState.remove();
      authListener?.data.subscription.unsubscribe();
      await backend.close();
    },
  };
}
