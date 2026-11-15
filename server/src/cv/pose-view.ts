import {
  canonicalize, decodeRelease, GRID_N, PLAYBACK_FRAME_COUNT, releaseSeriesFromClip, WRIST_PEAK_AFTER_RELEASE_MS,
  type CompactRelease, type ReleaseMetrics, type ReleaseSeries,
} from './release.js';
import { decodePose, NE, NJ, type CompactPose } from './pose.js';

export function poseView(series: CompactRelease, metrics: ReleaseMetrics) {
  return releasePoseView(decodeRelease(series), metrics);
}

export function playbackPoseView(series: CompactRelease, metrics: ReleaseMetrics, source: CompactPose, releaseFrame: number) {
  const original = decodePose(source);
  const estimatedRelease = releaseFrame - WRIST_PEAK_AFTER_RELEASE_MS * original.fps / 1000;
  const extended = releaseSeriesFromClip(original, estimatedRelease, series.hand, PLAYBACK_FRAME_COUNT);
  // Use the same measured interval for normalization as the metrics and legacy comparison.
  const aligned = canonicalize(extended, GRID_N);
  return aligned ? releasePoseView(aligned, metrics) : poseView(series, metrics);
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
