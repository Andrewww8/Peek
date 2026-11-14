/**
 * Platform ports. The core never imports Expo directly: the app wires in
 * adapters/expo.ts, and the simulator wires in Node equivalents. This keeps
 * the exact same backend logic testable on the laptop.
 */

export type SqlValue = string | number | null;

export interface SqlDatabase {
  exec(sql: string): Promise<void>;
  /**
   * The only way to write, and never with RETURNING. expo-sqlite's runAsync
   * makes one step in one bridge call; a write without RETURNING runs to
   * SQLITE_DONE on that step, and halting commits its implicit transaction
   * there, before the (separate) finalize. lastInsertRowId is meaningful
   * only when changes > 0.
   */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number; lastInsertRowId: number }>;
  /** Reads only. */
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /**
   * Reads only. Never pass a write (INSERT … RETURNING etc.): expo-sqlite's
   * getFirstAsync steps once, which stops a RETURNING write at its first row
   * before it halts, and finalizes in a later bridge call. Until then the
   * connection's implicit transaction stays open, other writes that "succeed"
   * meanwhile are uncommitted, and a kill before the finalize undoes them.
   */
  first<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  /**
   * BEGIN, work, COMMIT on the one shared connection. NOT serialized on
   * expo-sqlite (withTransactionAsync): a second caller's BEGIN fails, and its
   * ROLLBACK, along with any other query that lands in between, hits this
   * transaction. Only init-time migrations use it, before the backend is
   * handed out. Runtime writes must be single atomic statements.
   */
  transaction(work: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export interface FileInfo {
  exists: boolean;
  size: number | null;
}

export interface FileStore {
  /** Persistent app storage, file:// URI ending in "/". */
  readonly documentUri: string;
  /** OS-purgeable cache, file:// URI ending in "/". */
  readonly cacheUri: string;
  info(uri: string): Promise<FileInfo>;
  ensureDir(uri: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Idempotent. */
  remove(uri: string): Promise<void>;
  /** File names in a directory; [] when it does not exist. */
  list(dirUri: string): Promise<string[]>;
  freeBytes(): Promise<number>;
  /**
   * Streams url into destUri. Resolves with the HTTP status; rejects on
   * network failure/timeout. With maxBytes, once more than maxBytes bytes have
   * been received the transfer stops and the promise rejects with an Error
   * whose message contains "exceeded maxBytes".
   */
  download(
    url: string,
    destUri: string,
    opts: { timeoutMs: number; maxBytes?: number; onProgress?: (bytesWritten: number) => void },
  ): Promise<{ status: number }>;
  /**
   * Streams the file at fileUri as the raw request body (expo: uploadAsync
   * with BINARY_CONTENT). Resolves with the HTTP status; rejects on network
   * failure or after timeoutMs.
   */
  upload(
    url: string,
    fileUri: string,
    opts: { method: 'PUT'; headers: Record<string, string>; timeoutMs: number },
  ): Promise<{ status: number }>;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** JSON text. */
  body?: string;
  signal?: AbortSignal;
}
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponseLike>;

/**
 * A streamed HTTP response. Resolves once the status and headers are in; the
 * body then arrives through `chunks` as UTF-8 text, in order, split anywhere
 * (even inside a multi-byte character's text or an SSE event, so consumers
 * reassemble). Iterating ends when the body ends, and throws when the
 * connection fails or `init.signal` aborts. Leaving the loop early cancels the body.
 */
export interface StreamResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  chunks: AsyncIterable<string>;
}
export type StreamFetch = (url: string, init?: FetchInit) => Promise<StreamResponse>;

export interface AuthPort {
  /**
   * The signed-in player's access token, or null when signed out. A stale
   * token is fine: the API answers 401 and the work stays queued. Must not
   * hang: an adapter that refreshes over the network bounds that wait.
   */
  getAccessToken(): Promise<string | null>;
}

export interface Platform {
  db: SqlDatabase;
  files: FileStore;
  fetch: FetchLike;
  /** Streaming fetch for Server-Sent Events (the AI coach). */
  stream: StreamFetch;
  auth: AuthPort;
  newId(): string;
  now(): number;
}
