import type { ApiClient, CoachMessage } from './apiClient';
import { NETWORK } from './config';
import { BackendError, type BackendErrorCode } from './errors';
import type { Platform } from './ports';

/**
 * What the chat screen should show for a session:
 * - not_configured: the build has no API URL.
 * - signed_out: sign-in prompt.
 * - not_synced: the session has no synced shot yet. Wait for the clip sync.
 * - offline: no connection to the API at all (no network, or no answer in time).
 * - unreachable: the API answered, but not healthily.
 * - daily_limit: the API refused a message today with coach_daily_limit.
 * - ready.
 * Local stats work in every state.
 */
export type CoachAvailability =
  | 'not_configured'
  | 'signed_out'
  | 'not_synced'
  | 'offline'
  | 'unreachable'
  | 'daily_limit'
  | 'ready';

export interface CoachToolStatus {
  /** Tool name when the API sends one. */
  tool: string | null;
  /** Human-readable progress, e.g. "Looking at shot 3…". */
  message: string;
}

export interface CoachSendOptions {
  /** Each piece of the answer as it streams in. */
  onToken?: (text: string) => void;
  onStatus?: (status: CoachToolStatus) => void;
  /** Aborting rejects send() with `cancelled`. */
  signal?: AbortSignal;
}

export interface CoachReply {
  messageId: string | null;
  /** The whole answer (the done event's text, else the streamed tokens joined). */
  text: string;
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser (WHATWG rules). Feed it chunks split
 * anywhere; it emits complete events only. Handles \n, \r\n and \r line ends,
 * multi-line data, comments and a leading BOM; ignores id and retry.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private started = false;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    if (!this.started && this.buffer.length > 0) {
      this.started = true;
      if (this.buffer.charCodeAt(0) === 0xfeff) this.buffer = this.buffer.slice(1);
    }
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // A lone \r at the very end may be the first half of \r\n: wait for more.
      if (m[0] === '\r' && m.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      this.line(line, out);
    }
    return out;
  }

  /** End of stream: a final event without its blank line is dropped, as the spec says. */
  end(): SseEvent[] {
    this.buffer = '';
    this.event = '';
    this.data = [];
    return [];
  }

  private line(line: string, out: SseEvent[]) {
    if (line === '') {
      if (this.data.length > 0) out.push({ event: this.event || 'message', data: this.data.join('\n') });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}

const parseData = (data: string): any => {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
};
const str = (...vs: unknown[]) => vs.find((v): v is string => typeof v === 'string') ?? null;

/** The API's error code (SSE error event or JSON error body) → BackendError code. */
function codeFor(serverCode: string | null, status?: number): BackendErrorCode {
  if (serverCode === 'coach_daily_limit' || status === 429) return 'coach_daily_limit';
  if (serverCode === 'unauthorized' || status === 401) return 'unauthorized';
  if (serverCode === 'session_not_found' || serverCode === 'not_found' || status === 404) return 'not_found';
  return 'http_error';
}

/**
 * Chat with the AI coach about one synced session. Every number comes from
 * the API's tools; the phone only streams text. Needs a signed-in player.
 */
export class CoachClient {
  /** UTC day (YYYY-MM-DD) on which the API last answered coach_daily_limit. */
  private limitedOn: string | null = null;

  constructor(
    private readonly p: Platform,
    private readonly api: ApiClient,
  ) {}

  async availability(sessionId: string): Promise<CoachAvailability> {
    if (!this.api.baseUrl) return 'not_configured';
    let token: string | null;
    try {
      token = await this.p.auth.getAccessToken();
    } catch {
      token = null;
    }
    if (token === null) return 'signed_out';
    const synced = await this.p.db.first<{ x: number }>(
      `SELECT 1 AS x FROM shots WHERE session_id = ? AND clip_state IN ('synced', 'outcome_dirty') LIMIT 1`,
      [sessionId],
    );
    if (!synced) return 'not_synced';
    const health = await this.api.health();
    if (!health.ok) return health.code === 'unreachable' || health.code === 'timeout' ? 'offline' : 'unreachable';
    if (this.limitedOn === utcDay(this.p.now())) return 'daily_limit';
    return 'ready';
  }

  async history(sessionId: string): Promise<CoachMessage[]> {
    return this.api.coachHistory(await this.token(), sessionId);
  }

  async reset(sessionId: string): Promise<void> {
    await this.api.coachReset(await this.token(), sessionId);
  }

  /**
   * POSTs the message and streams the answer. Resolves when the API sends
   * `done`. Rejects with unauthorized, not_found (no synced clips),
   * coach_daily_limit, timeout, unreachable (connection lost, also mid-answer),
   * cancelled (signal aborted), not_configured, invalid_input, or http_error.
   */
  async send(sessionId: string, text: string, opts: CoachSendOptions = {}): Promise<CoachReply> {
    const message = text.trim();
    if (!message) throw new BackendError('invalid_input', 'Message is empty');
    const base = this.api.baseUrl;
    if (!base) throw new BackendError('not_configured', 'This build has no API URL (EXPO_PUBLIC_API_URL).');
    if (opts.signal?.aborted) throw new BackendError('cancelled', 'Cancelled');
    const token = await this.token();

    const ctrl = new AbortController();
    let why: 'cancelled' | 'timeout' | null = null;
    const abort = (reason: 'cancelled' | 'timeout') => {
      why ??= reason;
      ctrl.abort();
    };
    const onCaller = () => abort('cancelled');
    opts.signal?.addEventListener('abort', onCaller);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (ms: number) => {
      clearTimeout(idle);
      idle = setTimeout(() => abort('timeout'), ms);
    };
    const total = setTimeout(() => abort('timeout'), NETWORK.coachTotalTimeoutMs);
    const failure = (err: unknown): BackendError => {
      if (err instanceof BackendError) return err;
      if (why === 'cancelled') return new BackendError('cancelled', 'Cancelled');
      if (why === 'timeout') return new BackendError('timeout', 'The coach did not answer in time');
      return new BackendError('unreachable', `Lost the connection to the coach: ${(err as Error)?.message ?? err}`);
    };

    try {
      armIdle(NETWORK.coachConnectTimeoutMs);
      const path = `/v1/sessions/${encodeURIComponent(sessionId)}/coach/messages`;
      let res;
      try {
        res = await this.p.stream(base + path, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message }),
          signal: ctrl.signal,
        });
      } catch (err) {
        throw failure(err);
      }

      if (res.status < 200 || res.status >= 300) {
        let body = '';
        try {
          for await (const c of res.chunks) body += c;
        } catch {
          // the status alone decides
        }
        const parsed = parseData(body);
        const serverCode = str(parsed?.error, parsed?.code);
        throw new BackendError(
          codeFor(serverCode, res.status),
          str(parsed?.message) ?? `HTTP ${res.status} from the coach`,
          res.status,
        );
      }

      const parser = new SseParser();
      let streamed = '';
      try {
        for await (const chunk of res.chunks) {
          armIdle(NETWORK.coachIdleTimeoutMs);
          for (const ev of parser.push(chunk)) {
            const d = parseData(ev.data);
            if (ev.event === 'token') {
              const piece = typeof d === 'string' ? d : (str(d?.text, d?.token, d?.delta) ?? '');
              if (piece) {
                streamed += piece;
                opts.onToken?.(piece);
              }
            } else if (ev.event === 'tool_status') {
              const msg = typeof d === 'string' ? d : (str(d?.message, d?.status, d?.label) ?? '');
              opts.onStatus?.({ tool: typeof d === 'object' ? str(d?.tool, d?.name) : null, message: msg });
            } else if (ev.event === 'done') {
              const obj = typeof d === 'object' && d !== null ? d : {};
              return { messageId: str(obj.messageId, obj.id), text: str(obj.text) ?? streamed };
            } else if (ev.event === 'error') {
              const obj = typeof d === 'object' && d !== null ? d : {};
              const serverCode = str(obj.code, obj.error, typeof d === 'string' ? d : undefined);
              throw new BackendError(codeFor(serverCode), str(obj.message) ?? `Coach error ${serverCode ?? ''}`.trim());
            }
          }
        }
      } catch (err) {
        throw failure(err);
      }
      parser.end();
      throw new BackendError('unreachable', 'The coach stream ended before the answer was done');
    } catch (err) {
      if (err instanceof BackendError && err.code === 'coach_daily_limit') this.limitedOn = utcDay(this.p.now());
      throw err;
    } finally {
      clearTimeout(idle);
      clearTimeout(total);
      opts.signal?.removeEventListener('abort', onCaller);
    }
  }

  private async token(): Promise<string> {
    const token = await this.p.auth.getAccessToken();
    if (token === null) throw new BackendError('unauthorized', 'Sign in to chat with the coach');
    return token;
  }
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
