/**
 * Node stand-ins for expo-sqlite and expo-file-system/legacy, so the phone
 * core runs unchanged on the laptop.
 *
 * Fidelity rule: these adapters are never more forgiving than the iPhone.
 * Where expo's iOS behaviour is surprising, it is reproduced on purpose:
 *
 *  - SQL calls yield to the event loop before the statement runs and again
 *    before the result reaches JS, like the native bridge, so other JS flows
 *    interleave between any two statements. Call order is kept. run, first
 *    and all are split into expo-sqlite's separate prepare / execute /
 *    finalize calls (see openNodeSql).
 *  - A killed app loses every write SQLite had not committed, including a
 *    write that joined a still-active statement's implicit transaction.
 *  - transaction() is expo-sqlite's withTransactionAsync line for line: plain
 *    BEGIN / COMMIT / ROLLBACK on the shared connection, no queue. An
 *    overlapping call fails with "cannot start a transaction within a
 *    transaction", and its ROLLBACK undoes the transaction already open.
 *  - Only file:// URIs inside the app's Documents or Caches directory are
 *    accepted (expo's sandbox permission check). Anything else throws, and
 *    every failure is a rejected promise, never a synchronous throw.
 *  - move() deletes an existing destination first, then moves. Like iOS
 *    moveAsync this is not atomic: if the source is missing, the destination
 *    is already gone when the move fails.
 *  - download() stages the body outside the app's directories (NSURLSession's
 *    tmp file) and moves it onto the destination only when the response
 *    completes. A non-2xx body is still saved and the call resolves with the
 *    status. A dropped or timed-out connection rejects and leaves the
 *    destination untouched.
 *  - download({ maxBytes }) rejects with "exceeded maxBytes" as soon as the
 *    declared Content-Length or the bytes received pass the limit (the Expo
 *    adapter checks both on the first progress event); the destination is
 *    untouched and nothing past the limit is reported as progress.
 *  - fetch() resolves only once the whole body has arrived, like React
 *    Native's XHR-based fetch, and the caller's abort signal covers the body.
 *  - info/list treat only "missing" (ENOENT, ENOTDIR) as absent; any other
 *    error propagates, as getInfoAsync / readDirectoryAsync would.
 *
 * createNodePlatform also simulates the app process, so a scenario can kill
 * the app at any await point (see SimProcess).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FetchLike, FileStore, Platform, SqlDatabase, SqlValue } from '../mobile/src/core/ports';

/** Wraps every bridge call. The simulated process uses it to freeze a killed app. */
export type Gate = <T>(label: string, op: () => Promise<T>) => Promise<T>;
const openGate: Gate = (_label, op) => op();

const nextMacrotask = () => new Promise<void>((r) => setImmediate(r));

/**
 * One hop to native and one back, like an expo-sqlite async call. setImmediate
 * is FIFO, so statements still run in call order (one native queue per
 * connection), but other JS can run before the statement and before its result.
 */
async function bridged<T>(fn: () => T, queueTurns = 0): Promise<T> {
  await nextMacrotask();
  for (let i = 0; i < queueTurns; i++) await nextMacrotask();
  let value: T;
  try {
    value = fn();
  } catch (err) {
    await nextMacrotask();
    throw err;
  }
  await nextMacrotask();
  return value;
}

export interface NodeSql extends SqlDatabase {
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number; lastInsertRowId: number }>;
  /** Test hook, not part of the port: the app's connection has an open transaction. */
  inTransaction(): boolean;
  /**
   * Test hook: the next statement whose SQL matches fails when it executes
   * (once), like a disk or constraint error on the phone.
   */
  failNext(pattern: RegExp): void;
  /**
   * Test hook: every SQL call waits this many extra event-loop turns before it
   * runs, as when the SQLite native queue is busy while expo-file-system's
   * queue is not. Applied to every call alike, so call order is kept.
   */
  setLatency(turns: number): void;
  /**
   * Test hook: the process dies. Whatever SQLite had not committed is lost:
   * the database files are snapshotted as they are on disk (WAL frames only
   * count up to the last commit), the connection is closed (which would
   * otherwise commit pending statements), and the snapshot is put back with
   * the shared-memory index removed, so the next open recovers like a crash.
   */
  crash(): void;
}

/**
 * expo-sqlite 16 statements, hop for hop. Each step below is its own bridge
 * call, and other JS can run between them:
 *   runAsync:      prepareAsync, executeAsync (runs to completion), finalizeAsync
 *   getFirstAsync: prepareAsync, executeAsync (one step), getColumnNamesAsync, finalizeAsync
 *   getAllAsync:   prepareAsync, executeAsync (one step), getAllAsync (the rest), finalizeAsync
 * Between getFirstAsync's step and its finalize, a write statement (INSERT
 * ... RETURNING) is still active, so its autocommit transaction is open and
 * any write that lands meanwhile joins it: nothing commits until finalize.
 */
export function openNodeSql(path: string, gate: Gate = openGate): NodeSql {
  const db = new DatabaseSync(path);
  const plain = <T>(row: unknown) => (row ? ({ ...(row as object) } as T) : null);
  let latency = 0;
  const call = <T>(label: string, fn: () => T) => gate(label, () => bridged(fn, latency));
  const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 60);
  let failing: RegExp | null = null;
  const execute = <T>(s: string, fn: () => T): T => {
    if (failing?.test(s)) {
      failing = null;
      throw new Error(`disk I/O error (injected) executing ${short(s)}`);
    }
    return fn();
  };

  const sql: NodeSql = {
    exec: (s) => call(`db.exec ${short(s)}`, () => execute(s, () => void db.exec(s))),
    async run(s, params: SqlValue[] = []) {
      const stmt = await call(`db.run/prepare ${short(s)}`, () => db.prepare(s));
      const r = await call(`db.run/execute ${short(s)}`, () => execute(s, () => stmt.run(...params)));
      await call(`db.run/finalize ${short(s)}`, () => undefined);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async first<T>(s: string, params: SqlValue[] = []) {
      const stmt = await call(`db.first/prepare ${short(s)}`, () => db.prepare(s));
      const it = stmt.iterate(...params);
      const step = await call(`db.first/execute ${short(s)}`, () => execute(s, () => it.next()));
      await call(`db.first/columns ${short(s)}`, () => stmt.columns());
      await call(`db.first/finalize ${short(s)}`, () => void it.return?.());
      return step.done ? null : plain<T>(step.value);
    },
    async all<T>(s: string, params: SqlValue[] = []) {
      const stmt = await call(`db.all/prepare ${short(s)}`, () => db.prepare(s));
      const it = stmt.iterate(...params);
      const head = await call(`db.all/execute ${short(s)}`, () => execute(s, () => it.next()));
      const rows: T[] = head.done ? [] : [plain<T>(head.value)!];
      await call(`db.all/getAll ${short(s)}`, () => {
        for (let r = it.next(); !r.done; r = it.next()) rows.push(plain<T>(r.value)!);
      });
      await call(`db.all/finalize ${short(s)}`, () => void it.return?.());
      return rows;
    },
    // expo-sqlite withTransactionAsync, verbatim. Deliberately NOT serialized.
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
    close: () => call('db.close', () => db.close()),
    inTransaction: () => db.isOpen && db.isTransaction,
    failNext: (pattern) => void (failing = pattern),
    setLatency: (turns) => void (latency = Math.max(0, turns)),
    crash: () => {
      if (!db.isOpen) return;
      const names = [path, `${path}-wal`, `${path}-journal`];
      const onDisk = names.filter((n) => existsSync(n)).map((n) => [n, readFileSync(n)] as const);
      db.close();
      for (const n of [...names, `${path}-shm`]) rmSync(n, { force: true });
      for (const [n, bytes] of onDisk) writeFileSync(n, bytes);
    },
  };
  return sql;
}

export interface NodeFileStoreOptions {
  /** Override reported free space (low-disk scenarios). */
  freeBytes?: () => number | undefined;
  /** Where in-progress downloads are staged (NSURLSession's tmp). Default: <docDir>/../tmp. */
  stagingDir?: string;
  /** Aborts in-flight downloads (the app process was killed). */
  signal?: AbortSignal;
}

/** Download options, including ones the port may not declare yet (forwarded as-is). */
export interface DownloadOpts {
  timeoutMs: number;
  onProgress?: (bytesWritten: number) => void;
  maxBytes?: number;
}

const isMissing = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException)?.code ?? '');
const dirUri = (path: string) => pathToFileURL(path).href.replace(/\/?$/, '/');

export type NodeFileStore = FileStore & { download(url: string, destUri: string, opts: DownloadOpts): Promise<{ status: number }> };

export function createNodeFileStore(docDir: string, cacheDir: string, opts: NodeFileStoreOptions = {}): NodeFileStore {
  const roots = [resolve(docDir), resolve(cacheDir)];
  const staging = opts.stagingDir ?? join(docDir, '..', 'tmp');

  /**
   * expo-file-system's checks: a file:// URI (else "unsupported scheme"),
   * inside Documents or Caches (else "isn't readable/writable"). Deleting or
   * moving needs write access to the parent, so a sandbox root itself is
   * refused there. Like NSURL.path, the trailing slash is dropped.
   */
  function pathOf(uri: string, op: string, allowRoot = true): string {
    if (typeof uri !== 'string' || !/^file:\/\//i.test(uri)) throw new Error(`${op}: '${uri}' is not a file:// URI`);
    const path = fileURLToPath(uri).replace(/(.)\/+$/, '$1');
    const inside = roots.some((r) => path.startsWith(r + sep) || (allowRoot && path === r));
    if (!inside) throw new Error(`${op}: location '${uri}' isn't accessible (outside the app sandbox)`);
    return path;
  }

  return {
    documentUri: dirUri(docDir),
    cacheUri: dirUri(cacheDir),

    async info(uri) {
      const path = pathOf(uri, 'getInfoAsync');
      try {
        const s = await stat(path);
        // The Expo adapter reports size null for directories (isDirectory).
        return { exists: true, size: s.isFile() ? s.size : null };
      } catch (err) {
        if (isMissing(err)) return { exists: false, size: null };
        throw err;
      }
    },

    async ensureDir(uri) {
      // Expo adapter: getInfoAsync, then makeDirectoryAsync({ intermediates: true }) only if nothing is there.
      const path = pathOf(uri, 'makeDirectoryAsync');
      try {
        await stat(path);
        return;
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
      await mkdir(path, { recursive: true });
    },

    async move(from, to) {
      const src = pathOf(from, 'moveAsync', false);
      const dst = pathOf(to, 'moveAsync', false);
      // iOS moveAsync: "The destination-delete and the move should happen atomically, but we hope for the best".
      await rm(dst, { recursive: true, force: true });
      await rename(src, dst);
    },

    async remove(uri) {
      // deleteAsync(uri, { idempotent: true }): recursive, no error when absent.
      await rm(pathOf(uri, 'deleteAsync', false), { recursive: true, force: true });
    },

    async list(uri) {
      // readDirectoryAsync throws on a missing directory; the Expo adapter checks getInfoAsync first
      // and returns [] unless it is a directory, which is what the port promises.
      const path = pathOf(uri, 'readDirectoryAsync');
      try {
        return await readdir(path);
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
    },

    async freeBytes() {
      const forced = opts.freeBytes?.();
      if (forced !== undefined) return forced;
      const s = await statfs(roots[0]!);
      return s.bavail * s.bsize;
    },

    async download(url: string, destUri: string, { timeoutMs, onProgress, maxBytes }: DownloadOpts) {
      const dest = pathOf(destUri, 'downloadAsync', false);
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (opts.signal) signals.push(opts.signal);
      const stop = new AbortController();
      signals.push(stop.signal);
      const res = await fetch(url, { signal: AbortSignal.any(signals) });
      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (maxBytes !== undefined && declared > maxBytes) {
        stop.abort();
        throw new Error(`download exceeded maxBytes (${maxBytes}): Content-Length ${declared}`);
      }
      await mkdir(staging, { recursive: true });
      const staged = join(staging, `CFNetworkDownload_${randomUUID()}.tmp`);
      const fh = await open(staged, 'w');
      try {
        if (res.body) {
          const reader = res.body.getReader();
          let written = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (maxBytes !== undefined && written + value.byteLength > maxBytes) {
              stop.abort();
              throw new Error(`download exceeded maxBytes (${maxBytes}): ${written + value.byteLength} bytes received`);
            }
            await fh.write(value);
            written += value.byteLength;
            onProgress?.(written);
          }
        }
        await fh.close();
        // didFinishDownloadingToURL: replace whatever is at the destination with the finished body,
        // even for a 404/500 (the error page lands in the file; the caller checks the status).
        await rm(dest, { recursive: true, force: true });
        await rename(staged, dest);
      } catch (err) {
        await fh.close().catch(() => undefined);
        await rm(staged, { force: true });
        throw err;
      }
      return { status: res.status };
    },
  };
}

/**
 * The simulated app process. kill() is iOS terminating the app: no finally
 * block, cleanup or callback runs afterwards, every port call it has pending
 * or makes later never settles and never touches disk, in-flight downloads
 * drop, and uncommitted SQL is lost with the connection.
 */
export interface SimProcess {
  readonly killed: boolean;
  /** Port calls made so far. Each one is an await point where the app can die. */
  readonly calls: number;
  /** Label of the call the process died at (killAtCall), for failure messages. */
  readonly diedAt: string | null;
  /** Settles once the process is fully dead. */
  readonly died: Promise<void>;
  kill(): void;
  /** Die at the n-th port call from now. landLastCall: that call's side effect completes first; otherwise it never starts. */
  killAtCall(n: number, landLastCall: boolean): void;
  /** Die once a download has written at least this many bytes. */
  killAtDownloadBytes(bytes: number): void;
  disarm(): void;
}

export interface NodePlatform extends Platform {
  db: NodeSql;
  process: SimProcess;
}

export function createNodePlatform(root: string, opts: NodeFileStoreOptions = {}): NodePlatform {
  const ctrl = new AbortController();
  let state: 'alive' | 'dying' | 'dead' = 'alive';
  let calls = 0;
  let diedAt: string | null = null;
  let killAt: { call: number; land: boolean } | null = null;
  let killBytes: number | null = null;
  let onDeath!: () => void;
  const died = new Promise<void>((r) => (onDeath = r));
  const hang = () => new Promise<never>(() => undefined);

  const kill = () => {
    if (state === 'dead') return;
    state = 'dead';
    ctrl.abort(new Error('app process killed'));
    db.crash();
    onDeath();
  };

  const gate: Gate = (label, op) => {
    if (state !== 'alive') return hang();
    calls++;
    if (killAt && calls >= killAt.call) {
      diedAt = `${label} (${killAt.land ? 'after it ran' : 'before it ran'})`;
      state = 'dying';
      if (killAt.land) op().then(kill, kill);
      else kill();
      return hang();
    }
    return op().then(
      (v) => (state === 'alive' ? v : hang()),
      (err) => (state === 'alive' ? Promise.reject(err) : hang()),
    );
  };

  const db = openNodeSql(join(root, 'perspective.db'), gate);
  const raw = createNodeFileStore(join(root, 'Documents'), join(root, 'Caches'), {
    ...opts,
    stagingDir: join(root, 'tmp'),
    signal: ctrl.signal,
  });
  const files: FileStore = {
    documentUri: raw.documentUri,
    cacheUri: raw.cacheUri,
    info: (u) => gate('files.info', () => raw.info(u)),
    ensureDir: (u) => gate('files.ensureDir', () => raw.ensureDir(u)),
    move: (a, b) => gate('files.move', () => raw.move(a, b)),
    remove: (u) => gate('files.remove', () => raw.remove(u)),
    list: (u) => gate('files.list', () => raw.list(u)),
    freeBytes: () => gate('files.freeBytes', () => raw.freeBytes()),
    download: (url, dest, o) =>
      gate('files.download', () =>
        raw.download(url, dest, {
          timeoutMs: o.timeoutMs,
          maxBytes: o.maxBytes,
          onProgress: (n) => {
            if (state !== 'alive') return;
            if (killBytes !== null && n >= killBytes) return kill();
            o.onProgress?.(n);
          },
        }),
      ),
  };
  const fetchLike: FetchLike = (url, init) =>
    gate('fetch', async () => {
      const signal = init?.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal;
      // React Native's fetch (whatwg-fetch over XHR) resolves after the whole body, under the same signal.
      const res = await fetch(url, { signal });
      const text = await res.text();
      return { ok: res.ok, status: res.status, json: () => gate('fetch.json', async () => JSON.parse(text) as unknown) };
    });

  const process: SimProcess = {
    get killed() {
      return state !== 'alive';
    },
    get calls() {
      return calls;
    },
    get diedAt() {
      return diedAt;
    },
    died,
    kill,
    killAtCall: (n, land) => void (killAt = { call: calls + Math.max(1, n), land }),
    killAtDownloadBytes: (bytes) => void (killBytes = bytes),
    disarm: () => {
      killAt = null;
      killBytes = null;
    },
  };

  return { db, files, fetch: fetchLike, newId: () => randomUUID(), now: () => Date.now(), process };
}
