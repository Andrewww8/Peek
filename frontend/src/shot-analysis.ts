import { accountFetch } from './api.ts';

export interface ShotAnalysis {
  status: 'pending' | 'complete' | 'failed' | 'expired';
  usable: boolean;
  elbowAngleDeg: number | null;
  kneeFlexionDeg: number | null;
}

const angle = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 180 ? value : null;

export async function getShotAnalysis(
  baseUrl: string, sessionId: string, token: (refresh: boolean) => Promise<string | null>,
  signal: AbortSignal, fetchApi?: typeof fetch,
) {
  const request = accountFetch(baseUrl, token, fetchApi);
  const response = await request(`/v1/clips?sessionId=${encodeURIComponent(sessionId)}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Analysis lookup returned HTTP ${response.status}.`);
  }
  const body = await response.json() as { clips?: unknown };
  if (!Array.isArray(body.clips)) throw new Error('The clip service returned invalid analysis.');
  const shots = new Map<number, ShotAnalysis>();
  for (const clip of body.clips) {
    if (clip?.sessionId !== sessionId || !Number.isSafeInteger(clip.shotNumber)) continue;
    const status = clip.analysisStatus;
    if (status !== 'pending' && status !== 'complete' && status !== 'failed' && status !== 'expired') continue;
    shots.set(clip.shotNumber, {
      status,
      usable: clip.quality?.usable === true,
      elbowAngleDeg: angle(clip.metrics?.elbowAngleReleaseDeg),
      kneeFlexionDeg: angle(clip.metrics?.kneeFlexionMinDeg),
    });
  }
  return shots;
}
