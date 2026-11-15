import { requireOptionalNativeModule } from 'expo';
import { SQLiteStorage } from 'expo-sqlite/kv-store';
import { guestPoseFromVision, type VisionFrame } from './guest-pose-motion';
import { coordinatesPerFrame, type Pose } from './pose-3d';

type NativeProgress = { requestId: string; operation: 'detectRelease' | 'analyze'; progress: number };
const native = requireOptionalNativeModule<{
  isAvailable(): boolean;
  detectRelease(uri: string, requestId?: string): Promise<number>;
  analyze(uri: string, releaseMs: number, requestId?: string): Promise<{ frames: VisionFrame[] }>;
  addListener(event: 'onShotPoseProgress', listener: (event: NativeProgress) => void): { remove(): void };
}>('PeekShotPose');

export type ShotAnalysisTag = { shotNumber: number; releaseMs: number };
export type ShotAnalysisResult = { pose: Pose; releaseMs: number; version?: number };
export type ShotAnalysisState = {
  phase: 'queued' | 'detecting' | 'tracking' | 'complete' | 'failed';
  progress: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  result?: ShotAnalysisResult;
};

const cache = new SQLiteStorage('peek-guest-analysis');
// Old results may contain a padded second after release rather than a fresh track of the footage.
const analysisVersion = 2;
const dailyLimit = 5;
const usageKey = 'usage';
const states = new Map<string, ShotAnalysisState>();
const pending = new Map<string, Promise<ShotAnalysisResult>>();
const listeners = new Set<() => void>();
let queue: Promise<void> = Promise.resolve();
let requestSequence = 0;

export const hasOnDeviceAnalysis = () => native?.isAvailable() ?? false;
export const hasAutomaticAnalysis = () => hasOnDeviceAnalysis() && typeof native?.detectRelease === 'function';
export const needsShotAnalysisRefresh = (result: ShotAnalysisResult) => result.version !== analysisVersion;

function analysisKey(sessionId: string, tag?: ShotAnalysisTag) {
  return tag ? `pose:${sessionId}:${tag.shotNumber}:${tag.releaseMs}` : `auto-pose:${sessionId}`;
}

function readSavedAnalysis(key: string, tag?: ShotAnalysisTag): ShotAnalysisState | undefined {
  try {
    const json = cache.getItemSync(key);
    if (!json) return;
    // Earlier manual analyses stored the pose directly under the same key.
    const saved = JSON.parse(json) as Pose | ShotAnalysisState;
    const result = 'phase' in saved ? saved.result : tag ? { pose: saved, releaseMs: tag.releaseMs } : undefined;
    if (!result || !Number.isFinite(result.releaseMs) ||
        result.pose.frameCount * coordinatesPerFrame !== result.pose.joints.length) return;
    return 'phase' in saved ? saved : { phase: 'complete', progress: 1, result };
  } catch {
    // An unreadable pose can be computed again from the original recording.
  }
}

export function getShotAnalysisState(sessionId: string, tag?: ShotAnalysisTag) {
  const key = analysisKey(sessionId, tag);
  const previous = states.get(key);
  if (previous) return previous;
  const saved = readSavedAnalysis(key, tag);
  if (saved) states.set(key, saved);
  return saved;
}

export function subscribeToShotAnalysis(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function update(key: string, state: ShotAnalysisState) {
  states.set(key, state);
  for (const listener of listeners) listener();
}

export function startShotAnalysis(sessionId: string, uri: string, tag?: ShotAnalysisTag, isGuest = true): Promise<ShotAnalysisResult> {
  const key = analysisKey(sessionId, tag);
  const existing = pending.get(key);
  if (existing) return existing;
  const previous = getShotAnalysisState(sessionId, tag);
  const saved = previous?.result;
  if (saved && !needsShotAnalysisRefresh(saved)) return Promise.resolve(saved);

  const startedAt = Date.now();
  update(key, { phase: 'queued', progress: 0, startedAt, result: saved });
  const operation = queue.then(async () => {
    if (!native?.isAvailable()) throw new Error('On-device shot analysis requires iOS 17 or later.');
    if (!tag && !saved && !hasAutomaticAnalysis()) throw new Error('Install the latest Peek build to find the release automatically.');

    const day = new Date().toISOString().slice(0, 10);
    const [lastDay, lastCount] = (cache.getItemSync(usageKey) ?? '').split(':');
    const used = lastDay === day ? Number(lastCount) || 0 : 0;
    if (isGuest && !saved && used >= dailyLimit) {
      throw new Error('You’ve reached the limit of five new guest analyses on this iPhone today. Try again after midnight UTC.');
    }

    const requestId = String(++requestSequence);
    const scanShare = tag || saved ? 0 : 0.7;
    const subscription = native.addListener?.('onShotPoseProgress', (event) => {
      if (event.requestId !== requestId || !Number.isFinite(event.progress)) return;
      const fraction = Math.min(1, Math.max(0, event.progress));
      const previous = states.get(key);
      const detecting = event.operation === 'detectRelease';
      const phase = detecting ? 'detecting' : 'tracking';
      if (previous?.phase !== phase) return;
      const work = detecting ? fraction * scanShare : scanShare + fraction * (1 - scanShare);
      update(key, { phase, progress: Math.max(previous.progress, Math.min(0.99, work)), startedAt, result: saved });
    });

    try {
      if (!tag && !saved) update(key, { phase: 'detecting', progress: 0, startedAt });
      const releaseMs = saved?.releaseMs ?? tag?.releaseMs ?? await native.detectRelease(uri, requestId);
      update(key, { phase: 'tracking', progress: scanShare, startedAt, result: saved });
      const { frames } = await native.analyze(uri, releaseMs, requestId);
      const result = { pose: guestPoseFromVision(frames), releaseMs, version: analysisVersion };
      const state: ShotAnalysisState = { phase: 'complete', progress: 1, result, startedAt, finishedAt: Date.now() };
      const writes: [string, string][] = [[key, JSON.stringify(state)]];
      if (isGuest && !saved) writes.push([usageKey, day + ':' + (used + 1)]);
      await cache.multiSet(writes);
      update(key, state);
      return result;
    } finally {
      subscription?.remove();
    }
  }).catch((error: unknown) => {
    if (previous && saved) {
      update(key, previous);
      return saved;
    }
    const lastState = states.get(key);
    update(key, {
      phase: 'failed', progress: lastState?.progress ?? 0, startedAt, finishedAt: Date.now(),
      error: error instanceof Error ? error.message : 'This recording could not be analyzed.',
    });
    throw error;
  }).finally(() => { pending.delete(key); });
  pending.set(key, operation);
  queue = operation.then(() => undefined, () => undefined);
  return operation;
}
