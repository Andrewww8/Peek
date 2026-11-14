import { apiOrigin, httpsUrl } from './api.ts';
import type { PracticeStore } from './database.ts';

type CloudShot = ReturnType<PracticeStore['cloudShots']>[number];
type SyncStore = Pick<PracticeStore, 'pendingCloudSessions' | 'cloudShots' | 'finishCloudShot'>;
type CloudAccount = { id: string; accessToken: (refresh: boolean) => Promise<string | null> };
export type RecordingUploader = (url: string, path: string, headers: Record<string, string>, signal: AbortSignal) => Promise<number>;

const contentTypes = new Map([['mov', 'video/quicktime'], ['mp4', 'video/mp4'], ['m4v', 'video/x-m4v']]);
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

class CloudResponseError extends Error {
  readonly status: number;
  readonly from: 'api' | 'upload';

  constructor(status: number, from: 'api' | 'upload' = 'api') {
    super(from === 'api' ? `The clip service returned HTTP ${status}.` : `Blob upload returned HTTP ${status}.`);
    this.status = status;
    this.from = from;
  }
}

export async function syncCloudClips({ baseUrl, store, account, upload, hasRecording, signal, fetchApi = fetch }: {
  baseUrl: string;
  store: SyncStore;
  account: CloudAccount;
  upload: RecordingUploader;
  hasRecording: (path: string) => boolean;
  signal: AbortSignal;
  fetchApi?: typeof fetch;
}) {
  const origin = apiOrigin(baseUrl);
  let refreshedToken: string | null = null;
  let firstFailure: CloudResponseError | undefined;

  function defer(error: unknown) {
    // Keep working when a single item is rejected. Pause on connection
    // failures and API-wide auth, rate-limit, or unavailability responses.
    if (!(error instanceof CloudResponseError) ||
        error.from === 'api' && [401, 403, 429, 503].includes(error.status)) throw error;
    firstFailure ??= error;
  }

  async function apiCall(method: 'POST' | 'PATCH', path: string, body: unknown, timeout: number) {
    const url = new URL(path, origin);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    const send = (token: string) => fetchApi(url.href, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: requestSignal,
    });
    const token = refreshedToken ?? await account.accessToken(false);
    if (!token || requestSignal.aborted) throw new Error('Clip sync paused.');
    let response = await send(token);
    if (response.status === 401 && !refreshedToken) {
      await response.body?.cancel();
      refreshedToken = await account.accessToken(true);
      if (!refreshedToken || requestSignal.aborted) throw new Error('Clip sync paused.');
      response = await send(refreshedToken);
    }
    if (!response.ok || method === 'PATCH') {
      const { ok, status } = response;
      await response.body?.cancel();
      if (!ok) throw new CloudResponseError(status);
      return null;
    }
    return await response.json() as unknown;
  }

  function finish(shots: CloudShot[], previous: 'pending' | 'dirty', result: 'saved' | 'unavailable') {
    if (signal.aborted) return;
    for (const shot of shots) store.finishCloudShot(account.id, shot, previous, result);
  }

  for (const session of store.pendingCloudSessions(account.id)) {
    if (signal.aborted) return;
    const pending = store.cloudShots(account.id, 'pending', session.id);
    if (!pending.length) continue;
    const path = session.videoPath;
    const ext = path?.split('.').pop()?.toLowerCase();
    const contentType = ext && contentTypes.get(ext);
    if (!path || !ext || !contentType || !hasRecording(path)) {
      finish(pending, 'pending', 'unavailable');
      continue;
    }

    // The API will cut at most 200 shots per upload. Each successful cut deletes the original on the server.
    for (let offset = 0; offset < pending.length; offset += 200) {
      if (signal.aborted) return;
      const batch = pending.slice(offset, offset + 200);
      try {
        const grant = await apiCall('POST', '/v1/recordings', {
          sessionId: session.id, ext, contentType, sizeBytes: session.sizeBytes,
          // The camera's container can be rounded just past 30 seconds. Let the cutter probe that case.
          durationMs: session.durationMs <= 30_000 ? session.durationMs : null,
        }, 12_000);
        if (!record(grant) || typeof grant.uploadId !== 'string' || !uuid.test(grant.uploadId) ||
            grant.method !== 'PUT' || typeof grant.uploadUrl !== 'string' || !record(grant.headers)) {
          throw new Error('The clip service returned an invalid upload grant.');
        }
        const destination = httpsUrl(grant.uploadUrl);
        if (!destination) throw new Error('The clip service returned an insecure upload URL.');
        const headers: Record<string, string> = Object.create(null);
        for (const [name, value] of Object.entries(grant.headers)) {
          // Blob PUT uses its signed URL and the headers from the grant. API credentials stay on Vercel's API origin.
          if (typeof value !== 'string' || /^(authorization|cookie|apikey|host)$/i.test(name)) {
            throw new Error('The clip service returned invalid upload headers.');
          }
          headers[name] = value;
        }
        if (signal.aborted) return;
        const status = await upload(destination.href, path, headers, AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
        if (status < 200 || status >= 300) throw new CloudResponseError(status, 'upload');
        if (signal.aborted) return;
        const result = await apiCall('POST', `/v1/recordings/${grant.uploadId}/clips`, {
          sessionId: session.id, shotType: session.shotType,
          shots: batch.map(({ shotNumber, releaseMs, outcome }) => ({ shotNumber, releaseMs, outcome })),
        }, 300_000);
        if (!record(result) || !Array.isArray(result.clips)) throw new Error('The clip service returned an invalid clip list.');
        const returned = new Map(result.clips.filter(record).map((clip) => [clip.shotNumber, clip]));
        for (const shot of batch) {
          const clip = returned.get(shot.shotNumber);
          if (clip && clip.error === undefined && typeof clip.sizeBytes === 'number' &&
              Number.isSafeInteger(clip.sizeBytes) && clip.sizeBytes > 0 &&
              typeof clip.startMs === 'number' && Number.isSafeInteger(clip.startMs) && clip.startMs >= 0 &&
              typeof clip.endMs === 'number' && Number.isSafeInteger(clip.endMs) && clip.endMs > clip.startMs) {
            finish([shot], 'pending', 'saved');
          } else if (clip?.error === 'release_beyond_duration') {
            finish([shot], 'pending', 'unavailable');
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof CloudResponseError && error.from === 'api' && [400, 413, 415, 422].includes(error.status)) {
          finish(batch, 'pending', 'unavailable');
          continue;
        }
        defer(error);
      }
    }
  }

  for (const shot of store.cloudShots(account.id, 'dirty')) {
    if (signal.aborted) return;
    try {
      await apiCall('PATCH', `/v1/sessions/${encodeURIComponent(shot.sessionId)}/shots/${shot.shotNumber}`,
        { outcome: shot.outcome }, 12_000);
      finish([shot], 'dirty', 'saved');
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof CloudResponseError && error.status === 404) {
        finish([shot], 'dirty', 'unavailable');
      } else {
        defer(error);
      }
    }
  }
  if (firstFailure) throw firstFailure;
}
