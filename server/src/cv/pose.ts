/**
 * A single person's pose over time, and its compact quantized encoding.
 *
 * Coordinates follow the CV output: 2D keypoints in image pixels, 3D pose
 * pelvis-rooted. In both, **up is −y**. Measured on the sample npz:
 * mean (head − pelvis) = (−0.01, −0.40, −0.05) and mean (r_ankle − pelvis) =
 * (−0.01, +0.36, +0.02) in pose3d, and head is ~200 px above the pelvis in 2D.
 */
import { deflateSync, inflateSync } from 'fflate';

export const JOINTS = [
  'pelvis', 'r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle', 'spine', 'thorax',
  'nose', 'head', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_shoulder', 'r_elbow', 'r_wrist',
] as const;
export type JointName = (typeof JOINTS)[number];
export const J = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<JointName, number>;
export const NJ = 17;
export const EXTREMITIES = [
  'l_middle_tip', 'r_middle_tip', 'l_index_tip', 'r_index_tip', 'l_middle_knuckle', 'r_middle_knuckle',
  'l_big_toe', 'r_big_toe', 'l_small_toe', 'r_small_toe', 'l_heel', 'r_heel',
] as const;
export const NE = EXTREMITIES.length;

/** One track's frames, sorted by frame number. Missing 3D joints are NaN. */
export interface PoseSeries {
  fps: number;
  effectiveFps?: number; // Tracking cadence when the CV pipeline samples source frames
  frames: number[];
  kpts2d: Float32Array; // F × 17 × 2
  conf: Float32Array; // F × 17
  pose3d: Float32Array; // F × 17 × 3
  extremities3d?: Float32Array; // F × 12 × 3, with NaN for unobserved points
  bbox: Float32Array; // F × 4 (x1, y1, x2, y2)
}

// ---------- compact encoding ----------
// int16 with fixed scales; NaN is stored as -32768.
const NAN16 = -32768;
// 3D: 1e-4 steps over ±3.27 (pelvis-rooted poses in the sample stay within ±1).
const SCALE = { px: 4, conf: 10_000, pose: 10_000 } as const;
export const COMPACT_POSE_VERSION = 1;

export interface CompactPose {
  v: typeof COMPACT_POSE_VERSION;
  fps: number;
  effectiveFps?: number;
  /** Number of frames. */
  n: number;
  /** base64 of deflate(int32 frames[n] ‖ int16 kpts2d ‖ int16 bbox ‖ int16 conf ‖ int16 pose3d), little-endian. */
  data: string;
  /** Optional base64 of deflated, quantized extremities. Absent in earlier recordings. */
  extremities?: string;
}

const q = (v: number, scale: number) => (Number.isFinite(v) ? Math.max(-32767, Math.min(32767, Math.round(v * scale))) : NAN16);
const dq = (v: number, scale: number) => (v === NAN16 ? NaN : v / scale);

export function encodePose(s: PoseSeries): CompactPose {
  const n = s.frames.length;
  const frames = Int32Array.from(s.frames);
  const parts = [
    { src: s.kpts2d, scale: SCALE.px },
    { src: s.bbox, scale: SCALE.px },
    { src: s.conf, scale: SCALE.conf },
    { src: s.pose3d, scale: SCALE.pose },
  ].map(({ src, scale }) => Int16Array.from(src, (v) => q(v, scale)));
  const total = frames.byteLength + parts.reduce((a, p) => a + p.byteLength, 0);
  const raw = new Uint8Array(total);
  let off = 0;
  for (const arr of [frames, ...parts]) {
    raw.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), off);
    off += arr.byteLength;
  }
  const result: CompactPose = { v: COMPACT_POSE_VERSION, fps: s.fps, n, data: Buffer.from(deflateSync(raw, { level: 9 })).toString('base64') };
  if (s.effectiveFps !== undefined) result.effectiveFps = s.effectiveFps;
  if (s.extremities3d) {
    const points = Int16Array.from(s.extremities3d, (value) => q(value, SCALE.pose));
    result.extremities = Buffer.from(deflateSync(new Uint8Array(points.buffer), { level: 9 })).toString('base64');
  }
  return result;
}

export function decodePose(c: CompactPose): PoseSeries {
  if (c.v !== COMPACT_POSE_VERSION) throw new Error(`unsupported compact pose version ${c.v}`);
  const raw = inflateSync(Buffer.from(c.data, 'base64'));
  const n = c.n;
  const sizes = [n * NJ * 2, n * 4, n * NJ, n * NJ * 3];
  const expected = n * 4 + sizes.reduce((a, b) => a + b, 0) * 2;
  if (raw.length !== expected) throw new Error('compact pose has the wrong length');
  const buf = raw.slice().buffer;
  const frames = Array.from(new Int32Array(buf, 0, n));
  let off = n * 4;
  const take = (len: number, scale: number) => {
    const ints = new Int16Array(buf, off, len);
    off += len * 2;
    return Float32Array.from(ints, (v) => dq(v, scale));
  };
  let extremities3d: Float32Array | undefined;
  if (c.extremities) {
    const points = inflateSync(Buffer.from(c.extremities, 'base64'));
    if (points.length !== n * NE * 3 * 2) throw new Error('compact extremities have the wrong length');
    extremities3d = Float32Array.from(new Int16Array(points.slice().buffer), (value) => dq(value, SCALE.pose));
  }
  return {
    fps: c.fps,
    ...(c.effectiveFps !== undefined ? { effectiveFps: c.effectiveFps } : {}),
    frames,
    kpts2d: take(sizes[0]!, SCALE.px),
    bbox: take(sizes[1]!, SCALE.px),
    conf: take(sizes[2]!, SCALE.conf),
    pose3d: take(sizes[3]!, SCALE.pose),
    ...(extremities3d ? { extremities3d } : {}),
  };
}

/** Round-trips a series through the encoding, so metrics computed now equal metrics recomputed later. */
export function quantize(s: PoseSeries): { series: PoseSeries; compact: CompactPose } {
  const compact = encodePose(s);
  return { series: decodePose(compact), compact };
}

/** Slices a series to frames in [from, to]. */
export function sliceSeries(s: PoseSeries, from: number, to: number): PoseSeries {
  const idx = s.frames.map((f, i) => (f >= from && f <= to ? i : -1)).filter((i) => i >= 0);
  const pick = (src: Float32Array, w: number) => {
    const out = new Float32Array(idx.length * w);
    idx.forEach((i, k) => out.set(src.subarray(i * w, i * w + w), k * w));
    return out;
  };
  return {
    fps: s.fps,
    ...(s.effectiveFps !== undefined ? { effectiveFps: s.effectiveFps } : {}),
    frames: idx.map((i) => s.frames[i]!),
    kpts2d: pick(s.kpts2d, NJ * 2),
    conf: pick(s.conf, NJ),
    pose3d: pick(s.pose3d, NJ * 3),
    ...(s.extremities3d ? { extremities3d: pick(s.extremities3d, NE * 3) } : {}),
    bbox: pick(s.bbox, 4),
  };
}
