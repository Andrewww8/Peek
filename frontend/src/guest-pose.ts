import { requireOptionalNativeModule } from 'expo';
import { SQLiteStorage } from 'expo-sqlite/kv-store';
import { guestPoseFromVision, type VisionFrame } from './guest-pose-motion';
import { coordinatesPerFrame, type Pose } from './pose-3d';

const native = requireOptionalNativeModule<{
  isAvailable(): boolean;
  analyze(uri: string, releaseMs: number): Promise<{ frames: VisionFrame[] }>;
}>('PeekShotPose');

const cache = new SQLiteStorage('peek-guest-analysis');
const dailyLimit = 5;
const usageKey = 'usage';
const pending = new Map<string, Promise<Pose>>();
let queue: Promise<void> = Promise.resolve();

export const hasOnDeviceAnalysis = () => native?.isAvailable() ?? false;

export function readGuestPose(key: string): Pose | undefined {
  const saved = cache.getItemSync(key);
  if (!saved) return;
  try {
    const pose = JSON.parse(saved) as Pose;
    if (pose.frameCount * coordinatesPerFrame === pose.joints.length) return pose;
  } catch {
    // An unreadable cached pose can be computed again from the saved clip.
  }
}

export function analyzeGuestShot(key: string, uri: string, releaseMs: number): Promise<Pose> {
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = queue.then(async () => {
    const saved = readGuestPose(key);
    if (saved) return saved;
    if (!native?.isAvailable()) throw new Error('On-device analysis requires iOS 17 or later.');
    const day = new Date().toISOString().slice(0, 10);
    const [lastDay, lastCount] = (cache.getItemSync(usageKey) ?? '').split(':');
    const used = lastDay === day ? Number(lastCount) || 0 : 0;
    if (used >= dailyLimit) {
      throw new Error('You’ve reached the limit of five new guest analyses on this iPhone today. Try again after midnight UTC.');
    }
    const { frames } = await native.analyze(uri, releaseMs);
    const pose = guestPoseFromVision(frames);
    await cache.multiSet([[key, JSON.stringify(pose)], [usageKey, day + ':' + (used + 1)]]);
    return pose;
  }).finally(() => pending.delete(key));
  pending.set(key, operation);
  queue = operation.then(() => undefined, () => undefined);
  return operation;
}
