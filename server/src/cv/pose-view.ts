import {
  canonicalize, decodeRelease, GRID_N, PLAYBACK_FRAME_COUNT, releaseSeriesFromClip, WRIST_PEAK_AFTER_RELEASE_MS,
  type CompactRelease, type ReleaseMetrics, type ReleaseSeries,
} from './release.js';
import { decodePose, J, NE, NJ, type CompactPose, type PoseSeries } from './pose.js';

type JumpSample = [rightAnkleUp: number | null, leftAnkleUp: number | null, pelvisUp: number | null,
  torsoLength: number | null];

function playbackJumpSamples(source: PoseSeries, release: number, pose: { fps: number; releaseIndex: number; frameCount: number }) {
  const samples = new Array<JumpSample | null>(pose.frameCount).fill(null);
  const distances = new Array<number>(pose.frameCount).fill(Infinity);
  for (const [index, sourceFrame] of source.frames.entries()) {
    const gridPosition = pose.releaseIndex + (sourceFrame - release) * pose.fps / source.fps;
    const frame = Math.round(gridPosition);
    const distance = Math.abs(frame - gridPosition);
    if (frame < 0 || frame >= pose.frameCount || distance >= distances[frame]!) continue;

    const joint = (id: number): [number, number] | null => {
      const offset = index * NJ + id;
      const x = source.kpts2d[offset * 2]!, y = source.kpts2d[offset * 2 + 1]!;
      // Ignore positions the worker filled in for lower confidence detections.
      return source.conf[offset]! >= 0.3 && Number.isFinite(x) && Number.isFinite(y) ? [x, -y] : null;
    };
    const right = joint(J.r_ankle), left = joint(J.l_ankle), pelvis = joint(J.pelvis);
    if (!right && !left && !pelvis) continue;
    const rightShoulder = joint(J.r_shoulder), leftShoulder = joint(J.l_shoulder);
    const torso = pelvis && rightShoulder && leftShoulder
      ? Math.hypot((rightShoulder[0] + leftShoulder[0]) / 2 - pelvis[0],
        (rightShoulder[1] + leftShoulder[1]) / 2 - pelvis[1])
      : null;
    samples[frame] = [right?.[1] ?? null, left?.[1] ?? null, pelvis?.[1] ?? null,
      torso !== null && torso > 0 ? torso : null];
    distances[frame] = distance;
  }
  return samples.some((sample) => sample !== null) ? samples : undefined;
}

export function poseView(series: CompactRelease, metrics: ReleaseMetrics) {
  return releasePoseView(decodeRelease(series), metrics);
}

export function playbackPoseView(series: CompactRelease, metrics: ReleaseMetrics, source: CompactPose, releaseFrame: number) {
  const original = decodePose(source);
  const estimatedRelease = releaseFrame - WRIST_PEAK_AFTER_RELEASE_MS * original.fps / 1000;
  const extended = releaseSeriesFromClip(original, estimatedRelease, series.hand, PLAYBACK_FRAME_COUNT);
  // Use the same measured interval for normalization as the metrics and legacy comparison.
  const aligned = canonicalize(extended, GRID_N);
  const pose = aligned ? releasePoseView(aligned, metrics) : poseView(series, metrics);
  const jumpSamples = playbackJumpSamples(original, estimatedRelease, pose);
  return jumpSamples ? { ...pose, jumpSamples } : pose;
}

export function releasePoseView(decoded: ReleaseSeries, metrics: ReleaseMetrics) {
  const samples = (values: Float32Array) => Array.from(values, (value) =>
    Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null,
  );
  const frameCount = decoded.pose.length / (NJ * 3);
  const extremities = decoded.extremities;
  const fingers = extremities ? Array.from({ length: frameCount }, (_, frame) => {
    const start = frame * NE * 3;
    return samples(extremities.subarray(start, start + 6 * 3));
  }).flat() : null;
  return {
    fps: decoded.fps,
    releaseIndex: decoded.releaseIndex,
    frameCount,
    shootingHand: decoded.hand,
    joints: samples(decoded.pose),
    fingers,
    pelvisRise: decoded.pelvisRise ? samples(decoded.pelvisRise) : null,
    metrics: {
      releaseElbowDeg: metrics.releaseElbowDeg,
      kneeDipDeg: metrics.kneeDipDeg,
      releaseHeight: metrics.releaseHeight,
    },
  };
}
