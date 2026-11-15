/**
 * Test helpers: a synthetic jump shot with known joint angles, and an .npz writer.
 *
 * Geometry (3D, metres-like, up = −y, x lateral, z forward), 30 fps, 121 frames:
 * - Knees: 175° standing, dipping linearly to 120° at frame 75, back to 175° by frame 88.
 *   Ankles stay on the ground (y = 0); the pelvis rides at the leg height 2·L·sin(κ/2).
 * - Shooting (right) arm in the sagittal plane through the shoulder (so elbow flare is 0):
 *   frames < 72 arm hanging; 72–80 raised with a 90° elbow (the set point);
 *   80→90 the elbow extends linearly to 170° while the upper arm rises from 45° to 10° (release at frame 90);
 *   90–100 held at 170° with the wrist above the shoulder; after 100 the arm drops.
 * - Trunk vertical (lean 0°), ankles ±0.1 and shoulders ±0.2 (ankle spread 0.5 shoulder widths).
 * 2D = (640 + 300·x, 600 + 300·y).
 */
import { zipSync } from 'fflate';
import { J, NJ, type PoseSeries } from './pose.js';

export const SHOT = { fps: 30, frames: 121, release: 90, dip: 75, setPoint: 72, elbowSet: 90, elbowRelease: 170, kneeMin: 120, holdFrames: 10 };
const L = 0.45; // thigh = shin
const ARM = 0.3; // upper arm = forearm
const rad = (d: number) => (d * Math.PI) / 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));

export function kneeAngle(f: number) {
  if (f <= 60 || f >= 88) return 175;
  return f <= SHOT.dip ? lerp(175, 120, (f - 60) / (SHOT.dip - 60)) : lerp(120, 175, (f - SHOT.dip) / (88 - SHOT.dip));
}
function arm(f: number): { beta: number; elbow: number } {
  // beta: upper-arm angle from straight up, towards forward (+z).
  if (f < 72) return { beta: 180, elbow: 170 };
  if (f <= 80) return { beta: 45, elbow: 90 };
  // The upper arm rises to 10° from vertical as the elbow extends, so the forearm is vertical at release
  // and the wrist is highest exactly then.
  if (f <= 90) return { beta: lerp(45, 10, (f - 80) / 10), elbow: lerp(90, 170, (f - 80) / 10) };
  if (f <= 100) return { beta: 10, elbow: 170 };
  return { beta: 180, elbow: 170 };
}

export interface ShotOptions {
  /** Joint confidence (default 0.9); `legConf` overrides hips, knees and ankles. */
  conf?: number;
  legConf?: number;
  /** Drop the 3D pose (NaN), as the CV does for about half the rows of the sample. */
  no3d?: boolean;
  /** Offset in pixels and scale, to make a second, smaller person. */
  dx?: number;
  scale?: number;
  frames?: number;
  frameOffset?: number;
}

/** 3D joints at frame f. */
export function joints3d(f: number): number[][] {
  const k = kneeAngle(f);
  const legH = 2 * L * Math.sin(rad(k / 2));
  const fwd = L * Math.cos(rad(k / 2));
  const p = new Array(NJ).fill(null).map(() => [0, 0, 0]);
  const pelvisY = -legH;
  p[J.pelvis] = [0, pelvisY, 0];
  for (const [hip, knee, ankle, x] of [[J.r_hip, J.r_knee, J.r_ankle, 0.1], [J.l_hip, J.l_knee, J.l_ankle, -0.1]] as const) {
    p[hip] = [x, pelvisY, 0];
    p[knee] = [x, pelvisY / 2, fwd];
    p[ankle] = [x, 0, 0];
  }
  p[J.spine] = [0, pelvisY - 0.25, 0];
  p[J.thorax] = [0, pelvisY - 0.5, 0];
  p[J.nose] = [0, pelvisY - 0.68, 0.08];
  p[J.head] = [0, pelvisY - 0.75, 0];
  p[J.r_shoulder] = [0.2, pelvisY - 0.5, 0];
  p[J.l_shoulder] = [-0.2, pelvisY - 0.5, 0];
  // Right (shooting) arm in the plane x = 0.2.
  const { beta, elbow } = arm(f);
  const S = p[J.r_shoulder]!;
  const u = [0, -Math.cos(rad(beta)), Math.sin(rad(beta))]; // shoulder → elbow
  const E = [S[0]!, S[1]! + ARM * u[1]!, S[2]! + ARM * u[2]!];
  // Forearm: rotate (S − E) = −u by the elbow angle within the y–z plane; take the higher wrist.
  const v = [-u[1]!, -u[2]!];
  const rot = (a: number) => [v[0]! * Math.cos(a) - v[1]! * Math.sin(a), v[0]! * Math.sin(a) + v[1]! * Math.cos(a)];
  const r1 = rot(rad(elbow)), r2 = rot(-rad(elbow));
  const r = r1[0]! < r2[0]! ? r1 : r2;
  p[J.r_elbow] = E;
  p[J.r_wrist] = [E[0]!, E[1]! + ARM * r[0]!, E[2]! + ARM * r[1]!];
  // Left arm hangs.
  p[J.l_elbow] = [-0.2, pelvisY - 0.2, 0];
  p[J.l_wrist] = [-0.2, pelvisY + 0.05, 0.05];
  return p;
}

export const to2d = (v: number[], o: ShotOptions = {}) => [640 + (o.dx ?? 0) + 300 * (o.scale ?? 1) * v[0]!, 600 + 300 * (o.scale ?? 1) * v[1]!];

export function syntheticShot(o: ShotOptions = {}): PoseSeries {
  const n = o.frames ?? SHOT.frames;
  const off = o.frameOffset ?? 0;
  const s: PoseSeries = {
    fps: SHOT.fps,
    frames: Array.from({ length: n }, (_, i) => i + off),
    kpts2d: new Float32Array(n * NJ * 2),
    conf: new Float32Array(n * NJ),
    pose3d: new Float32Array(n * NJ * 3),
    bbox: new Float32Array(n * 4),
  };
  for (let i = 0; i < n; i++) {
    const f = (i % SHOT.frames);
    const p = joints3d(f);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    p.forEach((v, j) => {
      const [x, y] = to2d(v, o);
      s.kpts2d.set([x!, y!], (i * NJ + j) * 2);
      // The CV's 3D pose is pelvis-rooted.
      const pelvis = p[J.pelvis]!;
      s.pose3d.set(o.no3d ? [NaN, NaN, NaN] : [v[0]! - pelvis[0]!, v[1]! - pelvis[1]!, v[2]! - pelvis[2]!], (i * NJ + j) * 3);
      const leg = [J.r_hip, J.r_knee, J.r_ankle, J.l_hip, J.l_knee, J.l_ankle].includes(j);
      s.conf[i * NJ + j] = leg && o.legConf !== undefined ? o.legConf : (o.conf ?? 0.9);
      x1 = Math.min(x1, x!); y1 = Math.min(y1, y!); x2 = Math.max(x2, x!); y2 = Math.max(y2, y!);
    });
    s.bbox.set([x1 - 10, y1 - 20, x2 + 10, y2 + 5], i * 4);
  }
  return s;
}

// ---------- npz writer ----------
function npy(descr: string, shape: number[], bytes: Uint8Array): Uint8Array {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const total = 10 + header.length + 1;
  header += ' '.repeat((64 - (total % 64)) % 64) + '\n';
  const out = new Uint8Array(10 + header.length + bytes.length);
  out.set([0x93, ...Buffer.from('NUMPY'), 1, 0], 0);
  new DataView(out.buffer).setUint16(8, header.length, true);
  out.set(Buffer.from(header, 'latin1'), 10);
  out.set(bytes, 10 + header.length);
  return out;
}
const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const u10 = (names: readonly string[]) => {
  const b = new Uint8Array(names.length * 40);
  const dv = new DataView(b.buffer);
  names.forEach((n, i) => [...n].forEach((c, k) => dv.setUint32((i * 10 + k) * 4, c.codePointAt(0)!, true)));
  return b;
};

export interface NpzPerson {
  track: number;
  series: PoseSeries;
}

/** Builds a CV-contract npz (deflated, like numpy.savez_compressed) from people's series. */
export function writeNpz(people: NpzPerson[], o: { fps?: number; cuts?: number[]; extra?: Record<string, Uint8Array> } = {}): Uint8Array {
  const rows: { track: number; frame: number; s: PoseSeries; i: number }[] = [];
  for (const p of people) p.series.frames.forEach((frame, i) => rows.push({ track: p.track, frame, s: p.series, i }));
  rows.sort((a, b) => a.frame - b.frame || a.track - b.track);
  const n = rows.length;
  const track = new Int32Array(n), frame = new Int32Array(n);
  const kpts = new Float32Array(n * NJ * 2), conf = new Float32Array(n * NJ), p3 = new Float32Array(n * NJ * 3), bbox = new Float32Array(n * 4);
  rows.forEach((r, k) => {
    track[k] = r.track;
    frame[k] = r.frame;
    kpts.set(r.s.kpts2d.subarray(r.i * NJ * 2, (r.i + 1) * NJ * 2), k * NJ * 2);
    conf.set(r.s.conf.subarray(r.i * NJ, (r.i + 1) * NJ), k * NJ);
    p3.set(r.s.pose3d.subarray(r.i * NJ * 3, (r.i + 1) * NJ * 3), k * NJ * 3);
    bbox.set(r.s.bbox.subarray(r.i * 4, (r.i + 1) * 4), k * 4);
  });
  const names = ['pelvis', 'r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle', 'spine', 'thorax', 'nose', 'head', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_shoulder', 'r_elbow', 'r_wrist'];
  const cuts = Int32Array.from(o.cuts ?? []);
  const files: Record<string, Uint8Array> = {
    'track.npy': npy('<i4', [n], bytesOf(track)),
    'frame.npy': npy('<i4', [n], bytesOf(frame)),
    'kpts2d.npy': npy('<f4', [n, NJ, 2], bytesOf(kpts)),
    'conf.npy': npy('<f4', [n, NJ], bytesOf(conf)),
    'bbox.npy': npy('<f4', [n, 4], bytesOf(bbox)),
    'pose3d.npy': npy('<f4', [n, NJ, 3], bytesOf(p3)),
    'pose3d_unit.npy': npy('<f4', [n, NJ, 3], bytesOf(p3)),
    'joint_names.npy': npy('<U10', [NJ], u10(names)),
    'bones.npy': npy('<i8', [1, 2], bytesOf(new BigInt64Array([0n, 1n]))),
    'fps.npy': npy('<f8', [], bytesOf(new Float64Array([o.fps ?? SHOT.fps]))),
    'eff_fps.npy': npy('<f8', [], bytesOf(new Float64Array([o.fps ?? SHOT.fps]))),
    'width.npy': npy('<i8', [], bytesOf(new BigInt64Array([1280n]))),
    'height.npy': npy('<i8', [], bytesOf(new BigInt64Array([720n]))),
    'cuts.npy': npy('<i4', [cuts.length], bytesOf(cuts)),
    ...o.extra,
  };
  return zipSync(files, { level: 6 });
}
export { npy as encodeNpy };
