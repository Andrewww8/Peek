/**
 * Real iPhone wiring: expo-sqlite, expo-file-system (legacy API), expo-crypto.
 * Typechecked against the installed Expo SDK by `npm install && npm run
 * typecheck` inside mobile/ (the laptop-wide typecheck covers only the core).
 */
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';
import { createPerspectiveBackend, type PerspectiveBackend } from '../core';
import type { FileStore, Platform, SqlDatabase, SqlValue } from '../core/ports';

async function openSql(name: string): Promise<SqlDatabase> {
  const db = await SQLite.openDatabaseAsync(name);
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params: SqlValue[] = []) => {
      // One step in one bridge call; a write without RETURNING halts and commits on it.
      const { changes, lastInsertRowId } = await db.runAsync(sql, params);
      return { changes, lastInsertRowId };
    },
    all: (sql, params: SqlValue[] = []) => db.getAllAsync(sql, params),
    first: (sql, params: SqlValue[] = []) => db.getFirstAsync(sql, params),
    // Not serialized: see SqlDatabase.transaction. Only init-time migrations use it.
    transaction: (work) => db.withTransactionAsync(work),
    close: () => db.closeAsync(),
  };
}

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
  // Release builds without a laptop URL get null, so the 3D viewer reports
  // not_configured instead of quietly calling the phone's own localhost (which
  // looks exactly like "laptop off"). Only development keeps the localhost default.
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim() || null;
  const apiBaseUrl = configured ?? (__DEV__ ? 'http://localhost:3001' : null);
  const backend = await createPerspectiveBackend(await createExpoPlatform(), { apiBaseUrl });
  return {
    ...backend,
    close: async () => {
      started = null;
      await backend.close();
    },
  };
}
