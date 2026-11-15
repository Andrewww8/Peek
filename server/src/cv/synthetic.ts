/**
 * Synthetic player clips built from pro templates, for tests, the simulator and the
 * hand-detection / self-ranking sweep (scripts/pro-sweep.ts).
 *
 * clipFromTemplate: the template's 37-frame release window padded by 30 frames on each side,
 * rotated about the vertical (camera yaw), rescaled like pose3d_unit, with a little noise, and a
 * 2D projection whose pelvis travels by pelvis_rise. The template's release lands on clip frame
 * 30 + 24 = 54, i.e. 1800 ms into a clip that starts at 0.
 */
import { NJ, type PoseSeries } from './pose.js';
import { RELEASE_INDEX, decodeRelease, mirror, type CompactRelease, type ReleaseSeries } from './release.js';

export const CLIP_PAD_FRAMES = 30;
export const TEMPLATE_CLIP_RELEASE_FRAME = CLIP_PAD_FRAMES + RELEASE_INDEX;
export const TEMPLATE_CLIP_RELEASE_MS = (TEMPLATE_CLIP_RELEASE_FRAME * 1000) / 30;

export interface ClipPose {
  yawDeg: number;
  scale: number;
  noise: number;
  seed: number;
}

export function clipFromTemplate(t: ReleaseSeries, o: ClipPose): PoseSeries {
  let seed = o.seed;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const pad = CLIP_PAD_FRAMES, N = 37 + 2 * pad;
  const c = Math.cos((o.yawDeg * Math.PI) / 180), s = Math.sin((o.yawDeg * Math.PI) / 180);
  const src = (f: number) => Math.max(0, Math.min(36, f - pad));
  const out: PoseSeries = { fps: 30, frames: Array.from({ length: N }, (_, i) => i), kpts2d: new Float32Array(N * NJ * 2), conf: new Float32Array(N * NJ).fill(0.9), pose3d: new Float32Array(N * NJ * 3), bbox: new Float32Array(N * 4) };
  for (let f = 0; f < N; f++) {
    const g = src(f);
    let y1 = Infinity, y2 = -Infinity, x1 = Infinity, x2 = -Infinity;
    for (let j = 0; j < NJ; j++) {
      const [x, y, z] = [0, 1, 2].map((d) => t.pose[(g * NJ + j) * 3 + d]!) as [number, number, number];
      const n = () => rnd() * o.noise;
      const X = (c * x - s * z) * o.scale + n(), Y = y * o.scale + n(), Z = (s * x + c * z) * o.scale + n();
      out.pose3d.set([X, Y, Z], (f * NJ + j) * 3);
      const px = 640 + 400 * X, py = 600 + 400 * (Y - (t.pelvisRise?.[g] ?? 0));
      out.kpts2d.set([px, py], (f * NJ + j) * 2);
      x1 = Math.min(x1, px); x2 = Math.max(x2, px); y1 = Math.min(y1, py); y2 = Math.max(y2, py);
    }
    out.bbox.set([x1 - 10, y1 - 0.08 * 400, x2 + 10, y2 + 0.04 * 400], f * 4);
  }
  return out;
}

/** A template as a player clip; `mirrored` turns a right-hander into a left-hander and vice versa. */
export function clipFromCompactTemplate(t: CompactRelease, o: ClipPose & { mirrored?: boolean }): PoseSeries {
  const s = decodeRelease(t);
  return clipFromTemplate(o.mirrored ? mirror(s) : s, o);
}

/** The simulator's pose distribution: yaw ±40°, scale ±5 %, noise 0.004, deterministic from `seed`. */
export function sweepPoses(count: number, seed: number): ClipPose[] {
  let s = seed | 0;
  // mulberry32
  const rng = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => ({ yawDeg: Math.round(rng() * 80 - 40), scale: 0.95 + rng() * 0.1, noise: 0.004, seed: 1 + Math.floor(rng() * 1_000_000) }));
}
