import { NETWORK } from './config';
import { BackendError, codeOf, type BackendErrorCode } from './errors';
import { isSafeSlug } from './paths';
import type { FetchLike } from './ports';

export interface DemoAsset {
  format: string;
  sizeBytes: number;
  url: string;
}
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
    'This build has no laptop URL. Set EXPO_PUBLIC_API_URL (for example http://192.168.1.20:3001) and rebuild. Recording, replay and stats work without it.',
  );

/**
 * baseUrl null (or blank) means the build was made without a laptop URL:
 * every network call fails at once with not_configured, so the 3D viewer can
 * say so instead of looking like "laptop off". Nothing else uses the network.
 */
export function createApiClient(opts: { baseUrl: string | null; fetch: FetchLike; timeoutMs?: number }) {
  const base = opts.baseUrl?.trim().replace(/\/+$/, '') || null;

  /** The timeout covers the body as well as the headers: a stalled body must not hang openDemo's queue. */
  async function getJson(path: string, timeoutMs: number): Promise<unknown> {
    if (!base) throw notConfigured();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const timeout = () => new BackendError('timeout', `Laptop did not answer within ${timeoutMs} ms`);
    try {
      let res;
      try {
        res = await opts.fetch(base + path, { signal: ctrl.signal });
      } catch {
        throw ctrl.signal.aborted ? timeout() : new BackendError('unreachable', `Cannot reach laptop at ${base}`);
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

  return {
    baseUrl: base,
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
