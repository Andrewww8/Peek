import { decodeRelease, type CompactRelease, type ReleaseMetrics } from './release.js';

export function poseView(series: CompactRelease, metrics: ReleaseMetrics) {
  const decoded = decodeRelease(series);
  const samples = (values: Float32Array) => Array.from(values, (value) =>
    Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null,
  );
  return {
    fps: decoded.fps,
    releaseIndex: decoded.releaseIndex,
    frameCount: series.n,
    shootingHand: decoded.hand,
    joints: samples(decoded.pose),
    pelvisRise: decoded.pelvisRise ? samples(decoded.pelvisRise) : null,
    metrics: {
      releaseElbowDeg: metrics.releaseElbowDeg,
      kneeDipDeg: metrics.kneeDipDeg,
      releaseHeight: metrics.releaseHeight,
    },
  };
}
