import { decodeRelease, type CompactRelease, type ReleaseMetrics } from './release.js';
import { NE } from './pose.js';

export function poseView(series: CompactRelease, metrics: ReleaseMetrics) {
  const decoded = decodeRelease(series);
  const samples = (values: Float32Array) => Array.from(values, (value) =>
    Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null,
  );
  const extremities = decoded.extremities;
  const fingers = extremities ? Array.from({ length: series.n }, (_, frame) => {
    const start = frame * NE * 3;
    return samples(extremities.subarray(start, start + 6 * 3));
  }).flat() : null;
  return {
    fps: decoded.fps,
    releaseIndex: decoded.releaseIndex,
    frameCount: series.n,
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
