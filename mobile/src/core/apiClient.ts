import { NETWORK } from './config';
import { BackendError, codeOf, type BackendErrorCode } from './errors';
import { isSafeSlug } from './paths';
import type { FetchLike } from './ports';

export interface DemoAsset {
  format: string;
  sizeBytes: number;
  url: string;
}
export interface RecordingUploadRequest {
  sessionId: string;
  ext: string;
  contentType: string;
  sizeBytes: number;
  /** Null when unknown (a clip recovered after a kill mid-save). */
  durationMs: number | null;
}
export interface RecordingUpload {
  uploadId: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}
export interface ClipShot {
  shotNumber: number;
  releaseMs: number;
  outcome: string;
}
export interface CreatedClip {
  ok: true;
  shotNumber: number;
  startMs: number;
  endMs: number;
  sizeBytes: number;
}
/** The API answered for this shot but cut no clip (e.g. release_beyond_duration). */
export interface FailedClip {
  ok: false;
  shotNumber: number;
  error: string;
  message: string;
}
export type ClipResult = CreatedClip | FailedClip;

export interface DemoEntry {
  id: string;
  version: number;
  shotType: string;
  cue: string;
  assets: DemoAsset[];
}

const ORIGIN = /^(https?:\/\/[^/?#]+)/i;

/**
 * Absolute HTTPS URLs pass through (future S3/CloudFront). Relative URLs
 * resolve against the API base. Absolute plain-HTTP is only accepted on the
 * API's own origin (the laptop on local Wi-Fi). Avoids the URL class, which
 * React Native only partially implements.
 */
export function resolveAssetUrl(baseUrl: string, url: string): string {
  if (/^https:\/\//i.test(url)) return url;
  const baseOrigin = ORIGIN.exec(baseUrl)?.[1];
  if (!baseOrigin) throw new BackendError('invalid_input', `Bad API base URL: ${baseUrl}`);
  if (/^http:\/\//i.test(url)) {
    if (ORIGIN.exec(url)?.[1]?.toLowerCase() === baseOrigin.toLowerCase()) return url;
    throw new BackendError('invalid_catalog', `Refusing non-HTTPS asset from another host: ${url}`);
  }
  if (url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) {
    throw new BackendError('invalid_catalog', `Unsupported asset URL: ${url}`);
  }
  if (url.startsWith('/')) return baseOrigin + url;
  const basePath = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return basePath + url;
}

function parseEntry(e: any): DemoEntry | null {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.id !== 'string' || !isSafeSlug(e.id)) return null;
  if (!Number.isInteger(e.version) || e.version < 1) return null;
  if (typeof e.shotType !== 'string' || typeof e.cue !== 'string' || !Array.isArray(e.assets)) return null;
  const assets = e.assets.filter(
    (a: any): a is DemoAsset =>
      typeof a?.format === 'string' &&
      /^[a-z0-9]+$/.test(a.format) &&
      Number.isInteger(a.sizeBytes) &&
      a.sizeBytes > 0 &&
      typeof a.url === 'string',
  );
  if (assets.length === 0) return null;
  return { id: e.id, version: e.version, shotType: e.shotType, cue: e.cue, assets };
}

const notConfigured = () =>
  new BackendError(
    'not_configured',
    'This build has no API URL. Set EXPO_PUBLIC_API_URL (the HTTPS URL of the Vercel deployment) and rebuild. Recording, replay and stats work without it.',
  );

/**
 * baseUrl null (or blank) means the build was made without an API URL:
 * every network call fails at once with not_configured, so the 3D viewer can
 * say so instead of looking like "API down", and clip sync skips its work.
 */
export function createApiClient(opts: { baseUrl: string | null; fetch: FetchLike; timeoutMs?: number }) {
  const base = opts.baseUrl?.trim().replace(/\/+$/, '') || null;

  /** The timeout covers the body as well as the headers: a stalled body must not hang openDemo's queue. */
  async function getJson(path: string, timeoutMs: number): Promise<unknown> {
    if (!base) throw notConfigured();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const timeout = () => new BackendError('timeout', `API did not answer within ${timeoutMs} ms`);
    try {
      let res;
      try {
        res = await opts.fetch(base + path, { signal: ctrl.signal });
      } catch {
        throw ctrl.signal.aborted ? timeout() : new BackendError('unreachable', `Cannot reach the API at ${base}`);
      }
      if (!res.ok) throw new BackendError('http_error', `HTTP ${res.status} from ${path}`);
      try {
        return await res.json();
      } catch {
        throw ctrl.signal.aborted ? timeout() : new BackendError('invalid_catalog', `Malformed JSON from ${path}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Authenticated JSON call. The bearer token goes with each request. 401 →
   * unauthorized, 404 → not_found, other non-2xx → http_error, no answer
   * within timeoutMs → timeout, no connection → unreachable.
   */
  async function authed(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    token: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!base) throw notConfigured();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const timeout = () => new BackendError('timeout', `API did not answer ${method} ${path} within ${timeoutMs} ms`);
    try {
      let res;
      try {
        res = await opts.fetch(base + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch {
        throw ctrl.signal.aborted ? timeout() : new BackendError('unreachable', `Cannot reach the API at ${base}`);
      }
      if (res.status === 401) throw new BackendError('unauthorized', `API refused the access token for ${method} ${path}`);
      if (res.status === 404) throw new BackendError('not_found', `${method} ${path}: not found`);
      if (!res.ok) throw new BackendError('http_error', `HTTP ${res.status} from ${method} ${path}`, res.status);
      if (method !== 'POST') return null;
      try {
        return await res.json();
      } catch {
        throw ctrl.signal.aborted ? timeout() : new BackendError('invalid_response', `Malformed JSON from ${method} ${path}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const invalid = (what: string) => new BackendError('invalid_response', `Unexpected ${what} response`);
  const shotPath = (sessionId: string, shotNumber: number) =>
    `/v1/sessions/${encodeURIComponent(sessionId)}/shots/${encodeURIComponent(String(shotNumber))}`;

  return {
    baseUrl: base,

    /** POST /v1/recordings: a short-lived URL to PUT one session's recording to. */
    async createRecordingUpload(token: string, req: RecordingUploadRequest): Promise<RecordingUpload> {
      const b: any = await authed('POST', '/v1/recordings', token, req, NETWORK.apiTimeoutMs);
      const headers = b?.headers ?? {};
      const ok =
        typeof b?.uploadId === 'string' &&
        b.uploadId.length > 0 &&
        typeof b.uploadUrl === 'string' &&
        /^https?:\/\//i.test(b.uploadUrl) &&
        b.method === 'PUT' &&
        typeof headers === 'object' &&
        Object.values(headers).every((v) => typeof v === 'string');
      if (!ok) throw invalid('POST /v1/recordings');
      return { uploadId: b.uploadId, uploadUrl: b.uploadUrl, method: 'PUT', headers, expiresAt: String(b.expiresAt ?? '') };
    },

    /** POST /v1/recordings/:uploadId/clips: cut one clip per shot. Idempotent per shot. */
    async createClips(
      token: string,
      uploadId: string,
      req: { sessionId: string; shotType: string; shots: ClipShot[] },
    ): Promise<ClipResult[]> {
      const path = `/v1/recordings/${encodeURIComponent(uploadId)}/clips`;
      const b: any = await authed('POST', path, token, req, NETWORK.clipCutTimeoutMs);
      if (!Array.isArray(b?.clips)) throw invalid(`POST ${path}`);
      const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
      return b.clips
        .filter((c: any) => Number.isInteger(c?.shotNumber))
        .map((c: any): ClipResult => {
          // A clip only counts as cut with no error and the full clip fields;
          // an error entry, or anything unrecognised, is a failure for that shot.
          if (c.error === undefined && num(c.startMs) && num(c.endMs) && num(c.sizeBytes)) {
            return { ok: true, shotNumber: c.shotNumber, startMs: c.startMs, endMs: c.endMs, sizeBytes: c.sizeBytes };
          }
          return {
            ok: false,
            shotNumber: c.shotNumber,
            error: typeof c.error === 'string' && c.error ? c.error : 'malformed_clip',
            message: typeof c.message === 'string' ? c.message : '',
          };
        });
    },

    /** PATCH /v1/sessions/:sessionId/shots/:shotNumber. */
    async patchShotOutcome(token: string, sessionId: string, shotNumber: number, outcome: string): Promise<void> {
      await authed('PATCH', shotPath(sessionId, shotNumber), token, { outcome }, NETWORK.apiTimeoutMs);
    },

    /** DELETE /v1/sessions/:sessionId/shots/:shotNumber. Idempotent. */
    async deleteShotClip(token: string, sessionId: string, shotNumber: number): Promise<void> {
      await authed('DELETE', shotPath(sessionId, shotNumber), token, undefined, NETWORK.apiTimeoutMs);
    },

    /** DELETE /v1/sessions/:sessionId: every clip of the session. Idempotent. */
    async deleteSessionClips(token: string, sessionId: string): Promise<void> {
      await authed('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}`, token, undefined, NETWORK.apiTimeoutMs);
    },

    resolveAssetUrl: (url: string) => {
      if (!base) throw notConfigured();
      return resolveAssetUrl(base, url);
    },

    async health(): Promise<{ ok: boolean; latencyMs: number; error?: string; code?: BackendErrorCode }> {
      const t0 = Date.now();
      try {
        const body: any = await getJson('/health', NETWORK.healthTimeoutMs);
        return { ok: body?.status === 'ok', latencyMs: Date.now() - t0 };
      } catch (err) {
        return { ok: false, latencyMs: Date.now() - t0, error: (err as Error).message, code: codeOf(err) };
      }
    },

    /** Invalid entries are dropped so one bad catalog edit cannot break the app. */
    async listDemos(shotType: string): Promise<DemoEntry[]> {
      const body = await getJson(
        `/v1/demos?shotType=${encodeURIComponent(shotType)}`,
        opts.timeoutMs ?? NETWORK.catalogTimeoutMs,
      );
      if (!Array.isArray(body)) throw new BackendError('invalid_catalog', 'Catalog response is not an array');
      return body.map(parseEntry).filter((e): e is DemoEntry => e !== null && e.shotType === shotType);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
