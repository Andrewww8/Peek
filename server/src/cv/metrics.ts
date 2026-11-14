/**
 * Deterministic shooting metrics from pose (PROJECT_CONTEXT.md, "Shot analysis").
 * Angles are computed in 3D when all three joints have a 3D estimate and in 2D
 * otherwise, so the results do not depend on units. Up is −y (see pose.ts).
 */
import { NpzError, readNpz, scalar, type NpyArray } from './npz.js';
import { J, JOINTS, NJ, decodePose, quantize, sliceSeries, type CompactPose, type PoseSeries } from './pose.js';
import {
  GRID_N,
  WRIST_PEAK_AFTER_RELEASE_MS,
  canonicalQuantized,
  computeCurves,
  computeReleaseMetrics,
  releaseSeriesFromClip,
  type CompactRelease,
  type Curves,
  type ReleaseMetrics,
} from './release.js';

/** 2: adds `comparison` (the release-aligned, pro-comparable metrics; see release.ts). */
export const ANALYSIS_VERSION = 2;

export class AnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------- npz → tracks ----------
export interface PoseArrays {
  fps: number;
  track: Int32Array;
  frame: Int32Array;
  kpts2d: Float32Array;
  conf: Float32Array;
  pose3d: Float32Array;
  bbox: Float32Array;
  cuts: number[];
  width: number;
  height: number;
}

function arr(a: Record<string, NpyArray>, name: string, dtype: string[], tail: number[]): NpyArray {
  const x = a[name];
  if (!x) throw new NpzError(`npz is missing ${name}`);
  if (!dtype.includes(x.dtype)) throw new NpzError(`${name} has dtype ${x.dtype}, expected ${dtype.join(' or ')}`);
  if (x.shape.length !== 1 + tail.length || tail.some((t, i) => x.shape[i + 1] !== t)) {
    throw new NpzError(`${name} has shape (${x.shape}), expected (N, ${tail.join(', ')})`);
  }
  return x;
}

/** Validates the CV npz contract and returns typed views. */
export function poseArraysFromNpz(bytes: Uint8Array): PoseArrays {
  const a = readNpz(bytes);
  const track = arr(a, 'track', ['<i4'], []);
  const frame = arr(a, 'frame', ['<i4'], []);
  const kpts2d = arr(a, 'kpts2d', ['<f4'], [NJ, 2]);
  const conf = arr(a, 'conf', ['<f4'], [NJ]);
  // Prefer the scale-normalized pose (see release.ts for how it compares with the templates).
  const pose3d = arr(a, a.pose3d_unit ? 'pose3d_unit' : 'pose3d', ['<f4'], [NJ, 3]);
  const bbox = arr(a, 'bbox', ['<f4'], [4]);
  const n = track.shape[0]!;
  for (const [name, x] of Object.entries({ frame, kpts2d, conf, pose3d, bbox })) {
    if (x.shape[0] !== n) throw new NpzError(`${name} has ${x.shape[0]} rows, track has ${n}`);
  }
  const names = a.joint_names?.data;
  if (names && (!Array.isArray(names) || names.join(',') !== JOINTS.join(','))) throw new NpzError('joint_names are not in H36M order');
  const fps = scalar(a.fps, 'fps');
  if (!(fps > 1 && fps < 1000)) throw new NpzError(`fps ${fps} is out of range`);
  const cuts = a.cuts ? Array.from(a.cuts.data as ArrayLike<number>) : [];
  return {
    fps,
    track: track.data as Int32Array,
    frame: frame.data as Int32Array,
    kpts2d: kpts2d.data as Float32Array,
    conf: conf.data as Float32Array,
    pose3d: pose3d.data as Float32Array,
    bbox: bbox.data as Float32Array,
    cuts,
    width: a.width ? scalar(a.width, 'width') : NaN,
    height: a.height ? scalar(a.height, 'height') : NaN,
  };
}

/** Rows of every track, sorted by frame. */
export function trackRows(p: PoseArrays): Map<number, number[]> {
  const rows = new Map<number, number[]>();
  for (let i = 0; i < p.track.length; i++) {
    const t = p.track[i]!;
    let list = rows.get(t);
    if (!list) rows.set(t, (list = []));
    list.push(i);
  }
  for (const list of rows.values()) list.sort((x, y) => p.frame[x]! - p.frame[y]!);
  return rows;
}

export function seriesOf(p: PoseArrays, rows: number[]): PoseSeries {
  const pick = (src: Float32Array, w: number) => {
    const out = new Float32Array(rows.length * w);
    rows.forEach((r, k) => out.set(src.subarray(r * w, r * w + w), k * w));
    return out;
  };
  return {
    fps: p.fps,
    frames: rows.map((r) => p.frame[r]!),
    kpts2d: pick(p.kpts2d, NJ * 2),
    conf: pick(p.conf, NJ),
    pose3d: pick(p.pose3d, NJ * 3),
    bbox: pick(p.bbox, 4),
  };
}

const boxArea = (b: Float32Array, i: number) => Math.max(0, b[i * 4 + 2]! - b[i * 4]!) * Math.max(0, b[i * 4 + 3]! - b[i * 4 + 1]!);
function meanConf(c: Float32Array, i: number) {
  let s = 0;
  for (let j = 0; j < NJ; j++) s += c[i * NJ + j]!;
  return s / NJ;
}

/** The shooter: present within ±5 frames of release; the largest box area × mean confidence there. */
export function pickShooter(p: PoseArrays, releaseFrame: number, rows = trackRows(p)): { track: number; rows: number[] } | null {
  let best: { track: number; rows: number[]; score: number } | null = null;
  for (const [track, list] of rows) {
    const near = list.filter((r) => Math.abs(p.frame[r]! - releaseFrame) <= 5);
    if (!near.length) continue;
    const score = near.reduce((a, r) => a + boxArea(p.bbox, r) * meanConf(p.conf, r), 0) / near.length;
    if (!best || score > best.score || (score === best.score && track < best.track)) best = { track, rows: list, score };
  }
  return best && { track: best.track, rows: best.rows };
}

// ---------- geometry on a series ----------
type V = [number, number, number];
class Frames {
  readonly at = new Map<number, number>();
  constructor(readonly s: PoseSeries) {
    s.frames.forEach((f, i) => this.at.set(f, i));
  }
  has(f: number) {
    return this.at.has(f);
  }
  p2(f: number, j: number): [number, number] | null {
    const i = this.at.get(f);
    if (i === undefined) return null;
    const x = this.s.kpts2d[(i * NJ + j) * 2]!;
    const y = this.s.kpts2d[(i * NJ + j) * 2 + 1]!;
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  p3(f: number, j: number): V | null {
    const i = this.at.get(f);
    if (i === undefined) return null;
    const o = (i * NJ + j) * 3;
    const v: V = [this.s.pose3d[o]!, this.s.pose3d[o + 1]!, this.s.pose3d[o + 2]!];
    return v.every(Number.isFinite) ? v : null;
  }
  conf(f: number, j: number): number {
    const i = this.at.get(f);
    return i === undefined ? NaN : this.s.conf[i * NJ + j]!;
  }
  boxHeight(f: number): number {
    const i = this.at.get(f);
    if (i === undefined) return NaN;
    return this.s.bbox[i * 4 + 3]! - this.s.bbox[i * 4 + 1]!;
  }
  /** Angle at b in degrees (3D when available, else 2D). */
  angle(f: number, a: number, b: number, c: number): number | null {
    const A = this.p3(f, a), B = this.p3(f, b), C = this.p3(f, c);
    if (A && B && C) return angleDeg(sub(A, B), sub(C, B));
    const a2 = this.p2(f, a), b2 = this.p2(f, b), c2 = this.p2(f, c);
    if (!a2 || !b2 || !c2) return null;
    return angleDeg([a2[0] - b2[0], a2[1] - b2[1], 0], [c2[0] - b2[0], c2[1] - b2[1], 0]);
  }
  /** Height of joint a above joint b, in bbox heights (2D, positive = above). */
  above(f: number, a: number, b: number): number | null {
    const A = this.p2(f, a), B = this.p2(f, b), h = this.boxHeight(f);
    if (!A || !B || !(h > 0)) return null;
    return (B[1] - A[1]) / h;
  }
}
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V) => Math.hypot(a[0], a[1], a[2]);
function angleDeg(u: V, v: V): number | null {
  const d = norm(u) * norm(v);
  if (!(d > 0)) return null;
  return (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / d))) * 180) / Math.PI;
}
const round = (v: number | null, digits = 1) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(digits)));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ---------- metrics ----------
export interface ShotMetrics {
  shootingHand: 'right' | 'left';
  releaseFrame: number;
  /** Release frame minus the tagged frame (the tag is a manual estimate). */
  releaseOffsetFrames: number;
  elbowAngleSetPointDeg: number | null;
  elbowAngleReleaseDeg: number | null;
  kneeFlexionMinDeg: number | null;
  dipToReleaseMs: number | null;
  releaseHeightRatio: number | null;
  trunkLeanDeg: number | null;
  elbowFlareRatio: number | null;
  followThroughHoldMs: number | null;
  jumpRiseRatio: number | null;
  ankleSpreadRatio: number | null;
  pelvisDriftRatio: number | null;
}

export interface ShotQuality {
  meanConfidence: number;
  coverage: number;
  pose3dCoverage: number;
  cutInWindow: boolean;
  lowConfidenceJoints: string[];
  warnings: string[];
  usable: boolean;
}

export interface ShotSeries {
  /** ms relative to release, 10 Hz. */
  tMs: number[];
  elbow: (number | null)[];
  knee: (number | null)[];
  wristHeight: (number | null)[];
}

/** Pro-comparable view of a clip: release-aligned on the template grid, template body frame and scale. */
export interface ClipComparison {
  version: 1;
  metrics: ReleaseMetrics;
  curves: Curves;
  series: CompactRelease;
}

export interface ShotAnalysis {
  version: typeof ANALYSIS_VERSION;
  fps: number;
  shooterTrack: number;
  /** What the pose was analyzed against, so the metrics can be recomputed from `pose`. */
  input: { taggedReleaseFrame: number; windowStart: number; windowEnd: number; cuts: number[]; declaredHand?: 'right' | 'left' };
  hand: HandInfo;
  metrics: ShotMetrics;
  quality: ShotQuality;
  series: ShotSeries;
  /** Null when there is too little 3D pose around release to compare with the pros. */
  comparison: ClipComparison | null;
  pose: CompactPose;
}

const KEY_JOINTS = ['r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_shoulder', 'r_elbow', 'r_wrist', 'head'] as const;

export interface WindowInput {
  taggedReleaseFrame: number;
  windowStart: number;
  windowEnd: number;
  /** Scene-cut frames anywhere in the source (filtered to the window). */
  cuts: number[];
  /** The player's declared shooting hand; detection is the fallback. */
  declaredHand?: 'right' | 'left';
}

/** Which hand shoots, where that came from, and how sure detection is. */
export interface HandInfo {
  value: 'right' | 'left';
  source: 'declared' | 'detected';
  /** Detection's own call (also when a hand was declared, for comparison). */
  detected: 'right' | 'left';
  /** Detection confidence: `low` when the evidence is close to symmetric. */
  confidence: 'high' | 'low';
  /** Weighted evidence for "right" (> 0) vs "left" (< 0), each cue normalized and clipped to ±3. */
  score: number;
  evidence: Record<HandCue, number | null>;
}
export type HandCue = 'followThroughHeight' | 'guideHandDrop' | 'elbowExtension' | 'wristUnderBall' | 'elbowForward';
/**
 * Cue weights and scales, tuned on the pro-template sweep (scripts/pro-sweep.ts, 20 templates ×
 * both hands × 40 poses). During the rise and set the shooting wrist sits UNDER the ball (cocked,
 * palm up) while the guide hand is on its side, so the guide wrist is the higher one: that is the
 * wristUnderBall cue, and alone it is right for 1357/1600 sweep clips. "Elbow in front of the
 * shoulder line" points the wrong way on these averaged shots (393/1600), so it is recorded but
 * not weighted. Sweep accuracy of the weighted cues: 1600/1600 (see the report / pro-sweep).
 */
export const HAND_CUES: Record<HandCue, { weight: number; scale: number }> = {
  followThroughHeight: { weight: 1, scale: 0.02 },
  guideHandDrop: { weight: 1, scale: 0.02 },
  elbowExtension: { weight: 1, scale: 10 },
  wristUnderBall: { weight: 1, scale: 0.02 },
  elbowForward: { weight: 0, scale: 0.02 },
};
/** |score| below this is a low-confidence detection. */
export const HAND_CONFIDENCE_THRESHOLD = 0.5;

/** Metrics, quality, and series for one shooter's (already quantized) series. */
/** Shooting hand from the whole window's evidence (see HAND_CUES), unless one was declared. */
function detectHand(
  F: Frames,
  w: WindowInput,
  fr: (ms: number) => number,
  R: number,
  followHeight: (wrist: number) => number | null,
  rp: { f: number; h: number } | null,
  lp: { f: number; h: number } | null,
): HandInfo {
  const tag = w.taggedReleaseFrame;
  const frames = (a: number, b: number) => {
    const out: number[] = [];
    for (let f = Math.max(a, w.windowStart); f <= Math.min(b, w.windowEnd); f++) if (F.has(f)) out.push(f);
    return out;
  };
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
    return v.length ? mean(v) : null;
  };
  const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
  // 1. Follow-through: the shooting wrist stays higher above the head after release.
  const followThroughHeight = diff(followHeight(J.r_wrist), followHeight(J.l_wrist));
  // 2. Guide hand comes off: it drops more over the follow-through (y down, per box height).
  const drop = (wrist: number) => {
    const a = F.p2(tag, wrist), end = frames(tag, tag + R).at(-1);
    const b = end !== undefined ? F.p2(end, wrist) : null;
    const h = F.boxHeight(tag);
    return a && b && h > 0 ? (b[1] - a[1]) / h : null;
  };
  const guideHandDrop = diff(drop(J.l_wrist), drop(J.r_wrist));
  // 3. The shooting elbow is more extended through release.
  const elbowExtension = avg(frames(tag, tag + fr(200)).map((f) => diff(F.angle(f, J.r_shoulder, J.r_elbow, J.r_wrist), F.angle(f, J.l_shoulder, J.l_elbow, J.l_wrist))));
  // 4. Rise and set: the shooting wrist sits under the ball, so the guide wrist is higher (0.5 s before release).
  const wristUnderBall = avg(frames(tag - fr(500), tag).map((f) => diff(F.above(f, J.l_wrist, J.l_shoulder), F.above(f, J.r_wrist, J.r_shoulder))));
  // 5. Elbow under the ball: in front of the shoulder line (3D; forward = −(x × y) with x = left − right).
  const elbowForward = avg(
    frames(tag - fr(500), tag).map((f) => {
      const ls = F.p3(f, J.l_shoulder), rs = F.p3(f, J.r_shoulder), le = F.p3(f, J.l_elbow), re = F.p3(f, J.r_elbow);
      if (!ls || !rs || !le || !re) return null;
      const lx = ls[0] - rs[0], lz = ls[2] - rs[2], n = Math.hypot(lx, lz);
      if (!(n > 0)) return null;
      // x̂ = (lx, 0, lz)/n, ŷ = (0, 1, 0): behind = x̂ × ŷ = (−lz, 0, lx)/n, so forward = (lz, 0, −lx)/n.
      const fwd = (v: V, s0: V) => ((v[0] - s0[0]) * lz - (v[2] - s0[2]) * lx) / n;
      return fwd(re, rs) - fwd(le, ls);
    }),
  );
  const evidence: Record<HandCue, number | null> = { followThroughHeight, guideHandDrop, elbowExtension, wristUnderBall, elbowForward };
  let sum = 0, weights = 0;
  for (const [k, cue] of Object.entries(HAND_CUES) as [HandCue, { weight: number; scale: number }][]) {
    const v = evidence[k];
    if (v === null || cue.weight === 0) continue;
    sum += cue.weight * Math.max(-3, Math.min(3, v / cue.scale));
    weights += cue.weight;
  }
  const score = weights ? sum / weights : rp && lp ? (rp.h >= lp.h ? 1 : -1) : rp ? 1 : -1;
  const detected = score >= 0 ? 'right' : 'left';
  const rounded: Record<HandCue, number | null> = Object.fromEntries(Object.entries(evidence).map(([k, v]) => [k, v === null ? null : Number(v.toFixed(4))])) as never;
  return {
    value: w.declaredHand ?? detected,
    source: w.declaredHand ? 'declared' : 'detected',
    detected,
    confidence: Math.abs(score) < HAND_CONFIDENCE_THRESHOLD ? 'low' : 'high',
    score: Number(score.toFixed(3)),
    evidence: rounded,
  };
}

export function computeMetrics(s: PoseSeries, w: WindowInput): Omit<ShotAnalysis, 'version' | 'shooterTrack' | 'pose' | 'fps' | 'comparison'> {
  const F = new Frames(s);
  const fps = s.fps;
  const fr = (ms: number) => Math.round((ms * fps) / 1000);
  const inWin = (f: number) => f >= w.windowStart && f <= w.windowEnd;
  const range = (a: number, b: number) => {
    const out: number[] = [];
    for (let f = Math.max(a, w.windowStart); f <= Math.min(b, w.windowEnd); f++) if (F.has(f)) out.push(f);
    return out;
  };

  // Shooting hand: the wrist that stays higher through the follow-through (tag to +0.33 s). The guide
  // hand can be as high at release, but drops away after it; on the 20 averaged pro templates this
  // picks the right hand for 18 (peak height alone: 13). Release: that wrist's highest point within ±0.33 s of the tag.
  const R = Math.max(1, fr(330));
  const near = range(w.taggedReleaseFrame - R, w.taggedReleaseFrame + R);
  if (!near.length) throw new AnalysisError('shooter_not_found', 'the shooter is not tracked near the release');
  const followHeight = (wrist: number) => {
    const hs = range(w.taggedReleaseFrame, w.taggedReleaseFrame + R).map((f) => F.above(f, wrist, J.head)).filter((h): h is number => h !== null);
    return hs.length ? mean(hs) : null;
  };
  const peak = (wrist: number) => {
    let best: { f: number; h: number } | null = null;
    for (const f of near) {
      const h = F.above(f, wrist, J.head);
      if (h !== null && (!best || h > best.h)) best = { f, h };
    }
    return best;
  };
  const rp = peak(J.r_wrist), lp = peak(J.l_wrist);
  if (!rp && !lp) throw new AnalysisError('shooter_not_found', 'no wrist is visible near the release');
  const hand = detectHand(F, w, fr, R, followHeight, rp, lp);
  const right = hand.value === 'right';
  const rel = (right ? rp : lp)?.f ?? (rp ?? lp)!.f;
  const [SH, EL, WR] = right ? [J.r_shoulder, J.r_elbow, J.r_wrist] : [J.l_shoulder, J.l_elbow, J.l_wrist];
  const elbowAt = (f: number) => F.angle(f, SH, EL, WR);
  const kneeAt = (f: number) => {
    const k = [F.angle(f, J.r_hip, J.r_knee, J.r_ankle), F.angle(f, J.l_hip, J.l_knee, J.l_ankle)].filter((x): x is number => x !== null);
    return k.length ? mean(k) : null;
  };

  // Set point: the most flexed elbow in the 0.6 s before release, preferring frames with the wrist above the shoulder.
  const before = range(rel - fr(600), rel - 1);
  const raised = before.filter((f) => (F.above(f, WR, SH) ?? -1) > 0);
  let setPoint: number | null = null;
  for (const f of raised.length ? raised : before) {
    const e = elbowAt(f);
    if (e !== null && (setPoint === null || e < elbowAt(setPoint)!)) setPoint = f;
  }

  // Dip: the most flexed knees in the 1 s before release.
  let dip: number | null = null;
  for (const f of range(rel - fr(1000), rel)) {
    const k = kneeAt(f);
    if (k !== null && (dip === null || k < kneeAt(dip)!)) dip = f;
  }

  // Trunk lean: thorax − pelvis against up (−y).
  const trunkAt = (f: number) => {
    const t3 = F.p3(f, J.thorax), p3 = F.p3(f, J.pelvis);
    if (t3 && p3) return angleDeg(sub(t3, p3), [0, -1, 0]);
    const t2 = F.p2(f, J.thorax), p2 = F.p2(f, J.pelvis);
    return t2 && p2 ? angleDeg([t2[0] - p2[0], t2[1] - p2[1], 0], [0, -1, 0]) : null;
  };

  // Elbow flare at the set point: the elbow's offset from the shoulder–wrist line along the shoulder axis, per upper-arm length.
  const flareAt = (f: number | null): number | null => {
    if (f === null) return null;
    const S = F.p3(f, SH), E = F.p3(f, EL), W = F.p3(f, WR), Ls = F.p3(f, J.l_shoulder), Rs = F.p3(f, J.r_shoulder);
    if (!S || !E || !W || !Ls || !Rs) return null;
    const line = sub(W, S);
    const len = norm(line);
    const upper = norm(sub(E, S));
    if (!(len > 0) || !(upper > 0)) return null;
    const t = dot(sub(E, S), line) / (len * len);
    const off = sub(E, [S[0] + line[0] * t, S[1] + line[1] * t, S[2] + line[2] * t]);
    const axis = sub(Rs, Ls); // towards the right shoulder
    const a = norm(axis);
    if (!(a > 0)) return null;
    const outward = (dot(off, axis) / a) * (right ? 1 : -1);
    return outward / upper;
  };

  // Follow-through: consecutive frames after release with the wrist above the shoulder and the elbow at least 150°.
  let hold = 0;
  for (let f = rel + 1; f <= w.windowEnd; f++) {
    const e = F.has(f) ? elbowAt(f) : null;
    const up = F.has(f) ? F.above(f, WR, SH) : null;
    if (e === null || up === null || e < 150 || up <= 0) break;
    hold++;
  }

  // Jump: pelvis rise from the dip to its highest point around release, per bbox height at the dip.
  const pelvisY = (f: number) => F.p2(f, J.pelvis)?.[1] ?? null;
  let jump: number | null = null;
  if (dip !== null && pelvisY(dip) !== null && F.boxHeight(dip) > 0) {
    const ys = range(rel - fr(300), rel + fr(300)).map(pelvisY).filter((y): y is number => y !== null);
    if (ys.length) jump = (pelvisY(dip)! - Math.min(...ys)) / F.boxHeight(dip);
  }

  // Balance: ankle spread per shoulder width at the set point; pelvis horizontal drift from dip to 0.5 s after release.
  const at = setPoint ?? rel;
  const la = F.p2(at, J.l_ankle), ra = F.p2(at, J.r_ankle), ls = F.p2(at, J.l_shoulder), rs = F.p2(at, J.r_shoulder);
  const shoulderW = ls && rs ? Math.abs(ls[0] - rs[0]) : NaN;
  const spread = la && ra && shoulderW > 0 ? Math.abs(la[0] - ra[0]) / shoulderW : null;
  let drift: number | null = null;
  if (dip !== null) {
    const end = range(rel, rel + fr(500)).at(-1);
    const p0 = F.p2(dip, J.pelvis), p1 = end !== undefined ? F.p2(end, J.pelvis) : null;
    if (p0 && p1 && F.boxHeight(dip) > 0) drift = Math.abs(p1[0] - p0[0]) / F.boxHeight(dip);
  }

  const metrics: ShotMetrics = {
    shootingHand: right ? 'right' : 'left',
    releaseFrame: rel,
    releaseOffsetFrames: rel - w.taggedReleaseFrame,
    elbowAngleSetPointDeg: round(setPoint === null ? null : elbowAt(setPoint)),
    elbowAngleReleaseDeg: round(elbowAt(rel)),
    kneeFlexionMinDeg: round(dip === null ? null : kneeAt(dip)),
    dipToReleaseMs: dip === null ? null : Math.round(((rel - dip) * 1000) / fps),
    releaseHeightRatio: round(F.above(rel, WR, J.head), 3),
    trunkLeanDeg: round(trunkAt(rel)),
    elbowFlareRatio: round(flareAt(setPoint), 3),
    followThroughHoldMs: Math.round((hold * 1000) / fps),
    jumpRiseRatio: round(jump, 3),
    ankleSpreadRatio: round(spread, 2),
    pelvisDriftRatio: round(drift, 3),
  };

  // Quality, over the second before release and half a second after it.
  const qFrom = Math.max(w.windowStart, rel - fr(1000)), qTo = Math.min(w.windowEnd, rel + fr(500));
  const qFrames = range(qFrom, qTo);
  const expected = qTo - qFrom + 1;
  const confs: number[] = [];
  const jointConf = new Map<string, number[]>();
  let with3d = 0;
  for (const f of qFrames) {
    for (let j = 0; j < NJ; j++) confs.push(F.conf(f, j));
    for (const name of KEY_JOINTS) {
      const list = jointConf.get(name) ?? [];
      list.push(F.conf(f, J[name]));
      jointConf.set(name, list);
    }
    if (F.p3(f, J.pelvis) && F.p3(f, WR)) with3d++;
  }
  const meanConfidence = Number(mean(confs).toFixed(3));
  const coverage = Number((qFrames.length / expected).toFixed(3));
  const pose3dCoverage = Number((qFrames.length ? with3d / qFrames.length : 0).toFixed(3));
  const cutInWindow = w.cuts.some((c) => c > w.windowStart && c <= w.windowEnd);
  const lowConfidenceJoints = [...jointConf].filter(([, v]) => mean(v) < 0.3).map(([k]) => k);
  const warnings: string[] = [];
  if (cutInWindow) warnings.push('scene_cut_in_window');
  if (meanConfidence < 0.4) warnings.push('low_confidence');
  if (coverage < 0.8) warnings.push('sparse_tracking');
  if (pose3dCoverage < 0.5) warnings.push('little_3d_pose');
  if (lowConfidenceJoints.length) warnings.push('low_confidence_joints');
  if (Math.abs(metrics.releaseOffsetFrames) >= R) warnings.push('release_far_from_tag');
  const quality: ShotQuality = {
    meanConfidence: Number.isFinite(meanConfidence) ? meanConfidence : 0,
    coverage,
    pose3dCoverage,
    cutInWindow,
    lowConfidenceJoints,
    warnings,
    usable: !cutInWindow && coverage >= 0.6 && meanConfidence >= 0.3,
  };

  // 10 Hz series from 2 s before to 1 s after release.
  const tMs: number[] = [];
  for (let t = -2000; t <= 1000; t += 100) tMs.push(t);
  const sample = (fn: (f: number) => number | null, digits: number) =>
    tMs.map((t) => {
      const f = rel + fr(t);
      return inWin(f) && F.has(f) ? round(fn(f), digits) : null;
    });
  const series: ShotSeries = { tMs, elbow: sample(elbowAt, 1), knee: sample(kneeAt, 1), wristHeight: sample((f) => F.above(f, WR, J.head), 3) };

  return { input: { ...w, cuts: w.cuts.filter((c) => c > w.windowStart && c <= w.windowEnd) }, hand, metrics, quality, series };
}

/** The clip's pro-comparable metrics and curves, from the same engine as the templates. */
export function clipComparison(s: PoseSeries, releaseFrame: number, hand: 'right' | 'left'): ClipComparison | null {
  // releaseFrame is the wrist peak; the templates' release is WRIST_PEAK_AFTER_RELEASE_MS earlier.
  const rs = releaseSeriesFromClip(s, releaseFrame - (WRIST_PEAK_AFTER_RELEASE_MS * s.fps) / 1000, hand);
  let with3d = 0;
  for (let g = 0; g < GRID_N; g++) if (Number.isFinite(rs.pose[(g * NJ + J.r_wrist) * 3]!) && Number.isFinite(rs.pose[(g * NJ + J.l_wrist) * 3]!)) with3d++;
  if (with3d < GRID_N / 2) return null;
  const c = canonicalQuantized(rs);
  if (!c) return null;
  return { version: 1, metrics: computeReleaseMetrics(c.series), curves: computeCurves(c.series), series: c.compact };
}

function withComparison(s: PoseSeries, core: ReturnType<typeof computeMetrics>) {
  return { ...core, comparison: clipComparison(s, core.metrics.releaseFrame, core.metrics.shootingHand) };
}

/** Full analysis of one shooter window: quantize first, so recomputing from `pose` gives identical results. */
export function analyzeSeries(full: PoseSeries, shooterTrack: number, w: WindowInput): ShotAnalysis {
  const { series, compact } = quantize(sliceSeries(full, w.windowStart, w.windowEnd));
  return { version: ANALYSIS_VERSION, fps: full.fps, shooterTrack, ...withComparison(series, computeMetrics(series, w)), pose: compact };
}

/** Recomputes metrics and the pro comparison from a stored analysis' compact pose (e.g. after the metrics code improves). */
export function recompute(a: Pick<ShotAnalysis, 'pose' | 'input'>) {
  const s = decodePose(a.pose);
  return withComparison(s, computeMetrics(s, a.input));
}

/**
 * Analyzes one shot clip's npz. The clip starts at `startMs` of the recording;
 * the release was tagged at `releaseMs`. Frame numbers in the npz count from the clip's first frame.
 */
export function analyzeClipNpz(bytes: Uint8Array, shot: { releaseMs: number; startMs: number; endMs: number; declaredHand?: 'right' | 'left' }): ShotAnalysis {
  const p = poseArraysFromNpz(bytes);
  const tagged = Math.round(((shot.releaseMs - shot.startMs) * p.fps) / 1000);
  const lastFrame = Math.max(0, Math.round(((shot.endMs - shot.startMs) * p.fps) / 1000));
  const shooter = pickShooter(p, tagged);
  if (!shooter) throw new AnalysisError('shooter_not_found', 'nobody is tracked within 5 frames of the release');
  return analyzeSeries(seriesOf(p, shooter.rows), shooter.track, { taggedReleaseFrame: tagged, windowStart: 0, windowEnd: lastFrame, cuts: p.cuts, ...(shot.declaredHand ? { declaredHand: shot.declaredHand } : {}) });
}
