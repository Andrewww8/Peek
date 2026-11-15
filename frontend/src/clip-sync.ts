import { accountFetch, httpsUrl } from './api.ts';
import type { CloudSyncIssue, PracticeStore } from './database.ts';

type CloudShot = ReturnType<PracticeStore['cloudShots']>[number];
type SyncStore = Pick<PracticeStore, 'pendingCloudSessions' | 'cloudShots' | 'finishCloudShot'>;
type CloudAccount = { id: string; accessToken: (refresh: boolean) => Promise<string | null> };
export type RecordingUploader = (url: string, path: string, headers: Record<string, string>, signal: AbortSignal) => Promise<number>;

const contentTypes = new Map([['mov', 'video/quicktime'], ['mp4', 'video/mp4'], ['m4v', 'video/x-m4v']]);
const rejectedRecordingStatuses = new Set([400, 413, 415, 422]);
const responseIssues = new Map<unknown, CloudSyncIssue>([
  ['invalid_request', 'invalid_shot'],
  ['unsupported_media_type', 'unsupported_recording'],
  ['recording_too_large', 'recording_too_large'],
  ['recording_too_long', 'recording_too_long'],
  ['recording_unreadable', 'recording_unreadable'],
  ['clip_not_found', 'cloud_clip_missing'],
]);
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export class GuestQuotaError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

class CloudResponseError extends Error {
  readonly status: number;
  readonly from: 'api' | 'upload';
  readonly issue?: CloudSyncIssue;

  constructor(status: number, from: 'api' | 'upload' = 'api', issue?: CloudSyncIssue) {
    super(from === 'api' ? `The clip service returned HTTP ${status}.` : `Blob upload returned HTTP ${status}.`);
    this.status = status;
    this.from = from;
    this.issue = issue;
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
  const request = accountFetch(baseUrl, account.accessToken, fetchApi);
  let firstFailure: CloudResponseError | undefined;

  function defer(error: unknown) {
    // Keep working when a single item is rejected. Pause on connection
    // failures and API-wide auth, rate-limit, or unavailability responses.
    if (!(error instanceof CloudResponseError) ||
        error.from === 'api' && [401, 403, 429, 503].includes(error.status)) throw error;
    firstFailure ??= error;
  }

  async function apiCall(method: 'POST' | 'PATCH', path: string, body: unknown, timeout: number) {
    const response = await request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok) {
      const { status } = response;
      if (status === 429 || rejectedRecordingStatuses.has(status) || (method === 'PATCH' && status === 404)) {
        const error: unknown = await response.json().catch(() => null);
        if (status === 429 && record(error) && error.error === 'guest_daily_limit' && typeof error.message === 'string') {
          throw new GuestQuotaError(error.message);
        }
        const issue = record(error) ? responseIssues.get(error.error) : undefined;
        throw new CloudResponseError(status, 'api', issue);
      }
      await response.body?.cancel();
      throw new CloudResponseError(status);
    }
    if (method === 'PATCH') {
      await response.body?.cancel();
      return null;
    }
    return await response.json() as unknown;
  }

  function finish(shots: CloudShot[], previous: 'pending' | 'dirty', result: 'saved' | 'unavailable', issue?: CloudSyncIssue) {
    if (signal.aborted) return;
    for (const shot of shots) store.finishCloudShot(account.id, shot, previous, result, issue);
  }

  for (const session of store.pendingCloudSessions(account.id)) {
    if (signal.aborted) return;
    const pending = store.cloudShots(account.id, 'pending', session.id);
    if (!pending.length) continue;
    const path = session.videoPath;
    if (!path || !hasRecording(path)) {
      finish(pending, 'pending', 'unavailable', 'missing_recording');
      continue;
    }
    const ext = path.split('.').pop()?.toLowerCase();
    const contentType = ext && contentTypes.get(ext);
    if (!contentType) {
      finish(pending, 'pending', 'unavailable', 'unsupported_recording');
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
        let limitMessage: string | undefined;
        for (const shot of batch) {
          const clip = returned.get(shot.shotNumber);
          if (clip && clip.error === undefined && typeof clip.sizeBytes === 'number' &&
              Number.isSafeInteger(clip.sizeBytes) && clip.sizeBytes > 0 &&
              typeof clip.startMs === 'number' && Number.isSafeInteger(clip.startMs) && clip.startMs >= 0 &&
              typeof clip.endMs === 'number' && Number.isSafeInteger(clip.endMs) && clip.endMs > clip.startMs) {
            finish([shot], 'pending', 'saved');
          } else if (clip?.error === 'release_beyond_duration') {
            finish([shot], 'pending', 'unavailable', 'release_after_end');
          } else if (clip?.error === 'guest_daily_limit' && typeof clip.message === 'string') {
            limitMessage = clip.message;
          }
        }
        if (limitMessage) throw new GuestQuotaError(limitMessage);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof CloudResponseError && error.from === 'api' && rejectedRecordingStatuses.has(error.status)) {
          finish(batch, 'pending', 'unavailable', error.issue);
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
        finish([shot], 'dirty', 'unavailable', error.issue);
      } else {
        defer(error);
      }
    }
  }
  if (firstFailure) throw firstFailure;
}
