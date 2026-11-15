/**
 * One metrics engine for player clips and pro templates (PROJECT_CONTEXT.md,
 * "Professional reference library: averaged pro shot templates").
 *
 * Both sources are turned into a ReleaseSeries: a release-aligned 3D series on
 * the template grid (30 fps, −0.8 s … +0.4 s, release at index 24), pelvis-relative,
 * in the template body frame, at template scale. Then the same functions compute
 * metrics and curves, and compare them.
 *
 * Template body frame (from the CV team's `units`, confirmed on all 20 files):
 *   x = shooter right → left, y = down, z = behind the shooter (faces −z); right-handed (x × y = z).
 *
 * Raw clip `pose3d_unit` (measured on the sample broadcast npz):
 *   - camera frame: 3D x has the sign of image x in 98–99.6 % of confident rows, y is down,
 *     right-handed and NOT mirrored (after aligning the shoulder/hip line to x, the face points
 *     to −z in 68 % of rows, 89 % of the most confident ones; the rest is monocular depth noise);
 *   - not body-aligned: people face any direction, so we rotate about the vertical axis so that
 *     (left − right) of shoulders + hips at release becomes +x. z = x × y is then "behind".
 *   - scale: median skeletal height (head–thorax–pelvis + mean leg) is 0.998 in pose3d_unit and
 *     0.968 in the templates, so every series is rescaled to SKELETAL_HEIGHT.
 * The same canonicalization is applied to templates (where it is close to the identity).
 */
import { deflateSync, inflateSync } from 'fflate';
import { EXTREMITIES, J, NE, NJ, type PoseSeries } from './pose.js';

export const GRID_FPS = 30;
export const RELEASE_INDEX = 24;
export const GRID_N = 37;
export const GRID_T = Array.from({ length: GRID_N }, (_, i) => Number(((i - RELEASE_INDEX) / GRID_FPS).toFixed(3)));
/** Median skeletal height of the templates (head–thorax–pelvis plus mean leg length), in body heights. */
export const SKELETAL_HEIGHT = 0.968;
/**
 * The templates' release_index precedes the shooting wrist's highest point by 0–5 frames
 * (median 2.5 frames = 83 ms at 30 fps, measured on all 20 templates): the wrist keeps rising
 * after the ball leaves. Player clips find release as the wrist peak, so the comparison grid
 * puts their release this much earlier, matching the templates' convention.
 */
export const WRIST_PEAK_AFTER_RELEASE_MS = 83;
/** Curve comparisons allow this much timing slack (frames at 30 fps) for individual differences. */
export const MAX_LAG_FRAMES = 3;
/** Smallest joint_spread used when expressing deviation in spread units, in body heights. */
export const SPREAD_FLOOR = 0.02;

export { EXTREMITIES, NE } from './pose.js';
export const E = Object.fromEntries(EXTREMITIES.map((n, i) => [n, i])) as Record<(typeof EXTREMITIES)[number], number>;

export type Hand = 'right' | 'left';

export interface ReleaseSeries {
  fps: number;
  releaseIndex: number;
  hand: Hand;
  /** n × 17 × 3, pelvis-relative, body frame, y down. NaN where missing. */
  pose: Float32Array;
  /** n × 12 × 3, same frame, or null when the source has no extremities. */
  extremities: Float32Array | null;
  /** n, vertical pelvis travel in body heights (up positive), or null. */
  pelvisRise: Float32Array | null;
  /** n × 17, per-joint spread across the averaged shots (templates only). */
  spread: Float32Array | null;
}
const n = (s: ReleaseSeries) => s.pose.length / (NJ * 3);

// ---------- mirroring ----------
const JOINT_SWAP = [0, 4, 5, 6, 1, 2, 3, 7, 8, 9, 10, 14, 15, 16, 11, 12, 13];
const EXT_SWAP = [1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10];

/** Left–right mirror: negate x and swap left/right joints; a left-handed shot becomes right-handed. */
export function mirror(s: ReleaseSeries): ReleaseSeries {
  const m = (src: Float32Array, w: number, swap: number[]) => {
    const out = new Float32Array(src.length);
    for (let f = 0; f < src.length / (w * 3); f++) {
      for (let j = 0; j < w; j++) {
        const from = (f * w + swap[j]!) * 3, to = (f * w + j) * 3;
        out[to] = -src[from]!;
        out[to + 1] = src[from + 1]!;
        out[to + 2] = src[from + 2]!;
      }
    }
    return out;
  };
  let spread: Float32Array | null = null;
  if (s.spread) {
    spread = new Float32Array(s.spread.length);
    for (let f = 0; f < s.spread.length / NJ; f++) for (let j = 0; j < NJ; j++) spread[f * NJ + j] = s.spread[f * NJ + JOINT_SWAP[j]!]!;
  }
  return {
    ...s,
    hand: s.hand === 'right' ? 'left' : 'right',
    pose: m(s.pose, NJ, JOINT_SWAP),
    extremities: s.extremities && m(s.extremities, NE, EXT_SWAP),
    spread,
  };
}
export const rightHanded = (s: ReleaseSeries) => (s.hand === 'left' ? mirror(s) : s);

// ---------- canonical frame ----------
type V = [number, number, number];
const get = (a: Float32Array, w: number, f: number, j: number): V => [a[(f * w + j) * 3]!, a[(f * w + j) * 3 + 1]!, a[(f * w + j) * 3 + 2]!];
const finite = (v: V) => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1]! : NaN;
};

export function skeletalHeight(pose: Float32Array, f: number): number {
  const p = (j: number) => get(pose, NJ, f, j);
  const leg = (h: number, k: number, a: number) => len(sub(p(h), p(k))) + len(sub(p(k), p(a)));
  return len(sub(p(J.head), p(J.thorax))) + len(sub(p(J.thorax), p(J.pelvis))) + (leg(J.r_hip, J.r_knee, J.r_ankle) + leg(J.l_hip, J.l_knee, J.l_ankle)) / 2;
}

/**
 * Pelvis-relative, rotated about the vertical so (left − right) of shoulders + hips near
 * release is +x, and scaled to SKELETAL_HEIGHT. Returns null without enough 3D near release.
 */
export function canonicalize(s: ReleaseSeries): ReleaseSeries | null {
  const N = n(s);
  let lx = 0, lz = 0;
  for (let f = Math.max(0, s.releaseIndex - 3); f <= Math.min(N - 1, s.releaseIndex + 3); f++) {
    const d = [J.l_shoulder, J.l_hip].map((j) => get(s.pose, NJ, f, j)), r = [J.r_shoulder, J.r_hip].map((j) => get(s.pose, NJ, f, j));
    if (![...d, ...r].every(finite)) continue;
    lx += d[0]![0] + d[1]![0] - r[0]![0] - r[1]![0];
    lz += d[0]![2] + d[1]![2] - r[0]![2] - r[1]![2];
  }
  const norm = Math.hypot(lx, lz);
  if (!(norm > 0)) return null;
  const c = lx / norm, sn = lz / norm; // rotate (lx, lz) onto +x: x' = c·x + s·z, z' = −s·x + c·z
  const height = median(Array.from({ length: N }, (_, f) => skeletalHeight(s.pose, f)));
  if (!(height > 0)) return null;
  const k = SKELETAL_HEIGHT / height;
  const tf = (src: Float32Array, w: number) => {
    const out = new Float32Array(src.length);
    for (let f = 0; f < N; f++) {
      const pel = get(s.pose, NJ, f, J.pelvis);
      for (let j = 0; j < w; j++) {
        const v = sub(get(src, w, f, j), pel);
        const o = (f * w + j) * 3;
        out[o] = (c * v[0] + sn * v[2]) * k;
        out[o + 1] = v[1] * k;
        out[o + 2] = (-sn * v[0] + c * v[2]) * k;
      }
    }
    return out;
  };
  return {
    ...s,
    pose: tf(s.pose, NJ),
    extremities: s.extremities && tf(s.extremities, NE),
    spread: s.spread && Float32Array.from(s.spread, (v) => v * k),
  };
}

// ---------- metrics ----------
export interface ReleaseMetrics {
  releaseElbowDeg: number | null;
  setPointElbowDeg: number | null;
  kneeDipDeg: number | null;
  dipToReleaseMs: number | null;
  releaseHeight: number | null;
  trunkLeanDeg: number | null;
  elbowFlare: number | null;
  followThroughHoldMs: number | null;
  pelvisRisePeak: number | null;
  wristSnapDeg: number | null;
  stanceWidth: number | null;
  footTurnDeg: number | null;
}
export const RELEASE_METRIC_KEYS = [
  'releaseElbowDeg', 'setPointElbowDeg', 'kneeDipDeg', 'dipToReleaseMs', 'releaseHeight', 'trunkLeanDeg',
  'elbowFlare', 'followThroughHoldMs', 'pelvisRisePeak', 'wristSnapDeg', 'stanceWidth', 'footTurnDeg',
] as const satisfies readonly (keyof ReleaseMetrics)[];
export type ReleaseMetricKey = (typeof RELEASE_METRIC_KEYS)[number];

export interface Curves {
  tSeconds: number[];
  elbow: (number | null)[];
  knee: (number | null)[];
  wristHeight: (number | null)[];
  pelvisRise: (number | null)[];
  /** Mean joint_spread per frame (templates only). */
  spread: (number | null)[] | null;
}
export const CURVE_KEYS = ['elbow', 'knee', 'wristHeight', 'pelvisRise'] as const;
export type CurveKey = (typeof CURVE_KEYS)[number];

const deg = (u: V, v: V) => {
  const d = len(u) * len(v);
  return d > 0 ? (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / d))) * 180) / Math.PI : NaN;
};
const r = (v: number, digits: number) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);

/** Per-frame signals of a canonical series. */
function signals(s: ReleaseSeries) {
  const N = n(s);
  const right = s.hand === 'right';
  const [SH, EL, WR] = right ? [J.r_shoulder, J.r_elbow, J.r_wrist] : [J.l_shoulder, J.l_elbow, J.l_wrist];
  const p = (f: number, j: number) => get(s.pose, NJ, f, j);
  const x = (f: number, e: number) => get(s.extremities!, NE, f, e);
  const angle = (f: number, a: number, b: number, c: number) => {
    const A = p(f, a), B = p(f, b), C = p(f, c);
    return finite(A) && finite(B) && finite(C) ? deg(sub(A, B), sub(C, B)) : NaN;
  };
  const elbow = Array.from({ length: N }, (_, f) => angle(f, SH, EL, WR));
  const knee = Array.from({ length: N }, (_, f) => {
    const k = [angle(f, J.r_hip, J.r_knee, J.r_ankle), angle(f, J.l_hip, J.l_knee, J.l_ankle)].filter(Number.isFinite);
    return k.length ? k.reduce((a, b) => a + b, 0) / k.length : NaN;
  });
  // y is down: a positive height means the wrist is above the head.
  const wristHeight = Array.from({ length: N }, (_, f) => p(f, J.head)[1] - p(f, WR)[1]);
  const wristOverShoulder = Array.from({ length: N }, (_, f) => p(f, SH)[1] - p(f, WR)[1]);
  const pelvisRise = Array.from({ length: N }, (_, f) => (s.pelvisRise ? s.pelvisRise[f]! : NaN));
  const wristAngle = Array.from({ length: N }, (_, f) => {
    if (!s.extremities) return NaN;
    const tip = x(f, right ? E.r_middle_tip : E.l_middle_tip);
    const A = p(f, EL), B = p(f, WR);
    return finite(A) && finite(B) && finite(tip) ? deg(sub(A, B), sub(tip, B)) : NaN;
  });
  return { N, right, SH, EL, WR, p, x, elbow, knee, wristHeight, wristOverShoulder, pelvisRise, wristAngle };
}

export function computeReleaseMetrics(s: ReleaseSeries): ReleaseMetrics {
  const g = signals(s);
  const R = s.releaseIndex;
  const fr = (ms: number) => Math.round((ms * s.fps) / 1000);
  const argmin = (vals: number[], from: number, to: number, ok: (f: number) => boolean = () => true) => {
    let best = -1;
    for (let f = Math.max(0, from); f <= Math.min(g.N - 1, to); f++) if (Number.isFinite(vals[f]!) && ok(f) && (best < 0 || vals[f]! < vals[best]!)) best = f;
    return best;
  };
  const dip = argmin(g.knee, 0, R);
  let set = argmin(g.elbow, R - fr(600), R - 1, (f) => g.wristOverShoulder[f]! > 0);
  if (set < 0) set = argmin(g.elbow, R - fr(600), R - 1);

  const thorax = g.p(R, J.thorax), pelvis = g.p(R, J.pelvis);
  const lean = finite(thorax) && finite(pelvis) ? deg(sub(thorax, pelvis), [0, -1, 0]) : NaN;

  // Elbow alignment at the set point: how far the elbow sits outside the wrist (it should be under
  // the ball), along the body's left–right axis, per upper-arm length. Outward is −x for a
  // right-hander (x runs right → left) and +x for a left-hander.
  let flare = NaN;
  if (set >= 0) {
    const S = g.p(set, g.SH), El = g.p(set, g.EL), W = g.p(set, g.WR);
    const upper = finite(S) && finite(El) ? len(sub(El, S)) : NaN;
    if (finite(W) && finite(El) && upper > 0) flare = ((g.right ? -1 : 1) * (El[0] - W[0])) / upper;
  }

  // Follow-through hold: frames after release with the wrist above the shoulder and the elbow
  // within 10° of its release angle (averaged pro shots rarely reach a fixed 150°).
  let hold = 0;
  const relElbow = g.elbow[R]!;
  for (let f = R + 1; f < g.N; f++) {
    if (!(g.elbow[f]! >= relElbow - 10 && g.wristOverShoulder[f]! > 0)) break;
    hold++;
  }

  const pr = g.pelvisRise.filter(Number.isFinite);
  let snap = NaN;
  for (let f = R; f < g.N; f++) if (Number.isFinite(g.wristAngle[f]!)) snap = Math.max(Number.isFinite(snap) ? snap : -Infinity, 180 - g.wristAngle[f]!);

  // Feet over the load phase (start to the dip).
  let stance = NaN, turn = NaN;
  if (s.extremities && dip >= 0) {
    const widths: number[] = [], turns: number[] = [];
    for (let f = 0; f <= dip; f++) {
      const lh = g.x(f, E.l_heel), rh = g.x(f, E.r_heel), ls = g.p(f, J.l_shoulder), rs = g.p(f, J.r_shoulder);
      if ([lh, rh, ls, rs].every(finite)) {
        const sw = Math.hypot(ls[0] - rs[0], ls[2] - rs[2]);
        if (sw > 0) widths.push(Math.hypot(lh[0] - rh[0], lh[2] - rh[2]) / sw);
      }
      for (const [heel, toe] of [[E.l_heel, E.l_big_toe], [E.r_heel, E.r_big_toe]] as const) {
        const h = g.x(f, heel), t = g.x(f, toe);
        if (finite(h) && finite(t)) {
          const d = deg([t[0] - h[0], 0, t[2] - h[2]], [0, 0, -1]);
          if (Number.isFinite(d)) turns.push(d);
        }
      }
    }
    if (widths.length) stance = widths.reduce((a, b) => a + b, 0) / widths.length;
    if (turns.length) turn = turns.reduce((a, b) => a + b, 0) / turns.length;
  }

  return {
    releaseElbowDeg: r(g.elbow[R]!, 1),
    setPointElbowDeg: set >= 0 ? r(g.elbow[set]!, 1) : null,
    kneeDipDeg: dip >= 0 ? r(g.knee[dip]!, 1) : null,
    dipToReleaseMs: dip >= 0 ? Math.round(((R - dip) * 1000) / s.fps) : null,
    releaseHeight: r(g.wristHeight[R]!, 3),
    trunkLeanDeg: r(lean, 1),
    elbowFlare: r(flare, 3),
    followThroughHoldMs: Number.isFinite(g.elbow[R]!) ? Math.round((hold * 1000) / s.fps) : null,
    pelvisRisePeak: pr.length ? r(Math.max(...pr), 3) : null,
    wristSnapDeg: r(snap, 1),
    stanceWidth: r(stance, 2),
    footTurnDeg: r(turn, 1),
  };
}

export function computeCurves(s: ReleaseSeries): Curves {
  const g = signals(s);
  const c = (xs: number[], d: number) => xs.map((v) => r(v, d));
  const spread = s.spread
    ? Array.from({ length: g.N }, (_, f) => {
        let t = 0;
        for (let j = 0; j < NJ; j++) t += s.spread![f * NJ + j]!;
        return r(t / NJ, 4);
      })
    : null;
  return { tSeconds: GRID_T.slice(0, g.N), elbow: c(g.elbow, 1), knee: c(g.knee, 1), wristHeight: c(g.wristHeight, 3), pelvisRise: c(g.pelvisRise, 3), spread };
}

// ---------- player clips → ReleaseSeries ----------
/**
 * Resamples one shooter's (quantized) clip series onto the template grid around `releaseFrame`.
 * Pelvis rise comes from the 2D pelvis height relative to the window start, per box height.
 */
export function releaseSeriesFromClip(s: PoseSeries, releaseFrame: number, hand: Hand): ReleaseSeries {
  const pose = new Float32Array(GRID_N * NJ * 3).fill(NaN);
  const extremities = s.extremities3d ? new Float32Array(GRID_N * NE * 3).fill(NaN) : null;
  const rise = new Float32Array(GRID_N).fill(NaN);
  const pelvisY = (i: number) => s.kpts2d[(i * NJ + J.pelvis) * 2 + 1]!;
  const boxH = (i: number) => s.bbox[i * 4 + 3]! - s.bbox[i * 4 + 1]!;
  let base: number | null = null;
  let next = 0;
  const maxGap = Math.max(1, s.fps * 0.1);
  for (let g = 0; g < GRID_N; g++) {
    const fpos = releaseFrame + ((g - RELEASE_INDEX) * s.fps) / GRID_FPS;
    while (next < s.frames.length && s.frames[next]! < fpos - 1e-9) next++;
    const upper = s.frames[next];
    if (upper === undefined) continue;
    const i1 = next;
    const i0 = Math.abs(upper - fpos) < 1e-9 ? i1 : i1 - 1;
    const lower = s.frames[i0];
    if (lower === undefined || upper - lower > maxGap) continue;
    const w = i0 === i1 ? 0 : (fpos - lower) / (upper - lower);
    for (let k = 0; k < NJ * 3; k++) pose[g * NJ * 3 + k] = s.pose3d[i0 * NJ * 3 + k]! * (1 - w) + s.pose3d[i1 * NJ * 3 + k]! * w;
    if (extremities && s.extremities3d) {
      for (let k = 0; k < NE * 3; k++) {
        extremities[g * NE * 3 + k] = s.extremities3d[i0 * NE * 3 + k]! * (1 - w) + s.extremities3d[i1 * NE * 3 + k]! * w;
      }
    }
    const y = pelvisY(i0) * (1 - w) + pelvisY(i1) * w, h = boxH(i0) * (1 - w) + boxH(i1) * w;
    if (Number.isFinite(y) && h > 0) {
      base ??= y;
      rise[g] = (base - y) / h;
    }
  }
  return { fps: GRID_FPS, releaseIndex: RELEASE_INDEX, hand, pose, extremities, pelvisRise: rise, spread: null };
}

// ---------- compact encoding of a canonical series ----------
const NAN16 = -32768;
const q = (v: number, k: number) => (Number.isFinite(v) ? Math.max(-32767, Math.min(32767, Math.round(v * k))) : NAN16);
export interface CompactRelease {
  v: 1;
  hand: Hand;
  fps: number;
  releaseIndex: number;
  n: number;
  has: { extremities: boolean; pelvisRise: boolean; spread: boolean };
  /** base64(deflate(int16 pose ‖ extremities ‖ pelvisRise ‖ spread)), 1e-4 steps. */
  data: string;
}
const K = 10_000;
export function encodeRelease(s: ReleaseSeries): CompactRelease {
  const parts = [s.pose, s.extremities, s.pelvisRise, s.spread].filter((x): x is Float32Array => !!x);
  const ints = Int16Array.from(parts.flatMap((a) => Array.from(a, (v) => q(v, K))));
  return {
    v: 1,
    hand: s.hand,
    fps: s.fps,
    releaseIndex: s.releaseIndex,
    n: n(s),
    has: { extremities: !!s.extremities, pelvisRise: !!s.pelvisRise, spread: !!s.spread },
    data: Buffer.from(deflateSync(new Uint8Array(ints.buffer), { level: 9 })).toString('base64'),
  };
}
export function decodeRelease(c: CompactRelease): ReleaseSeries {
  const raw = inflateSync(Buffer.from(c.data, 'base64'));
  const ints = new Int16Array(raw.slice().buffer);
  let off = 0;
  const take = (len: number) => {
    const out = Float32Array.from(ints.subarray(off, off + len), (v) => (v === NAN16 ? NaN : v / K));
    off += len;
    return out;
  };
  const pose = take(c.n * NJ * 3);
  const extremities = c.has.extremities ? take(c.n * NE * 3) : null;
  const pelvisRise = c.has.pelvisRise ? take(c.n) : null;
  const spread = c.has.spread ? take(c.n * NJ) : null;
  if (off !== ints.length) throw new Error('compact release series has the wrong length');
  return { fps: c.fps, releaseIndex: c.releaseIndex, hand: c.hand, pose, extremities, pelvisRise, spread };
}
/** Canonicalize, then quantize, so values computed now equal values recomputed from the stored copy. */
export function canonicalQuantized(s: ReleaseSeries): { series: ReleaseSeries; compact: CompactRelease } | null {
  const c = canonicalize(s);
  if (!c) return null;
  const compact = encodeRelease(c);
  return { series: decodeRelease(compact), compact };
}

// ---------- comparison ----------
export type CurveScales = Record<CurveKey, number>;
export interface PhaseDeltas {
  load: Partial<Record<CurveKey, number | null>>;
  rise: Partial<Record<CurveKey, number | null>>;
  release: Partial<Record<CurveKey, number | null>>;
  followThrough: Partial<Record<CurveKey, number | null>>;
}
export const PHASES = ['load', 'rise', 'release', 'followThrough'] as const;

/** Frame ranges of the four phases, from a series' dip (min knee before release). */
export function phaseRanges(s: ReleaseSeries): Record<(typeof PHASES)[number], [number, number]> {
  const knee = computeCurves(s).knee;
  let dip = 0;
  for (let f = 0; f <= s.releaseIndex; f++) if (knee[f] !== null && (knee[dip] === null || knee[f]! < knee[dip]!)) dip = f;
  const R = s.releaseIndex, last = n(s) - 1;
  return { load: [0, dip], rise: [dip, R - 1], release: [R - 1, Math.min(last, R + 1)], followThrough: [R, last] };
}

const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/**
 * Curve RMSE per curve (frames where both are present) and their combination normalized by
 * `scales`, at the timing lag (|lag| ≤ MAX_LAG_FRAMES) that fits best. Positive lag: the player is later.
 */
export function curveDistance(a: Curves, b: Curves, scales: CurveScales): { perCurve: Record<CurveKey, number | null>; score: number | null; lagFrames: number } {
  let best: { perCurve: Record<CurveKey, number | null>; score: number | null; lagFrames: number } | null = null;
  for (let lag = 0; Math.abs(lag) <= MAX_LAG_FRAMES; lag = lag > 0 ? -lag : -lag + 1) {
    const perCurve = {} as Record<CurveKey, number | null>;
    const parts: number[] = [];
    for (const k of CURVE_KEYS) {
      const sq: number[] = [];
      a[k].forEach((v, i) => {
        const w = b[k][i - lag];
        if (v !== null && w !== null && w !== undefined) sq.push((v - w) ** 2);
      });
      const rmse = sq.length ? Math.sqrt(meanOf(sq)) : NaN;
      perCurve[k] = r(rmse, 4);
      if (Number.isFinite(rmse)) parts.push((rmse / scales[k]) ** 2);
    }
    const score = parts.length ? r(Math.sqrt(meanOf(parts)), 4) : null;
    if (score !== null && (!best || best.score === null || score < best.score)) best = { perCurve, score, lagFrames: lag };
  }
  return best ?? { perCurve: { elbow: null, knee: null, wristHeight: null, pelvisRise: null }, score: null, lagFrames: 0 };
}

/** Mean (player − pro) of each curve within each of the pro's phases. */
export function phaseDeltas(player: Curves, pro: Curves, ranges: ReturnType<typeof phaseRanges>): PhaseDeltas {
  const out = {} as PhaseDeltas;
  for (const ph of PHASES) {
    const [a, b] = ranges[ph];
    out[ph] = {};
    for (const k of CURVE_KEYS) {
      const d: number[] = [];
      for (let f = a; f <= b; f++) {
        const x = player[k][f], y = pro[k][f];
        if (x !== null && x !== undefined && y !== null && y !== undefined) d.push(x - y);
      }
      out[ph][k] = d.length ? r(meanOf(d), k === 'elbow' || k === 'knee' ? 1 : 3) : null;
    }
  }
  return out;
}

/**
 * Joint-position deviation from a pro, in units of that pro's own joint_spread
 * (floored at SPREAD_FLOOR), averaged per phase; plus the joints that deviate most.
 * Both series must be canonical and right-handed.
 */
export function spreadDeviation(player: ReleaseSeries, pro: ReleaseSeries, ranges: ReturnType<typeof phaseRanges>) {
  if (!pro.spread) return null;
  const N = Math.min(n(player), n(pro));
  const perFrameJoint = (f: number, j: number) => {
    const a = get(player.pose, NJ, f, j), b = get(pro.pose, NJ, f, j);
    if (!finite(a) || !finite(b)) return NaN;
    return len(sub(a, b)) / Math.max(pro.spread![f * NJ + j]!, SPREAD_FLOOR);
  };
  const byPhase = {} as Record<(typeof PHASES)[number], number | null>;
  for (const ph of PHASES) {
    const [a, b] = ranges[ph];
    const v: number[] = [];
    for (let f = a; f <= Math.min(b, N - 1); f++) for (let j = 1; j < NJ; j++) {
      const x = perFrameJoint(f, j);
      if (Number.isFinite(x)) v.push(x);
    }
    byPhase[ph] = v.length ? r(meanOf(v), 2) : null;
  }
  const names = ['pelvis', 'r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle', 'spine', 'thorax', 'nose', 'head', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_shoulder', 'r_elbow', 'r_wrist'];
  const joints = names
    .map((name, j) => {
      const v: number[] = [];
      for (let f = 0; f < N; f++) {
        const x = perFrameJoint(f, j);
        if (Number.isFinite(x)) v.push(x);
      }
      return { joint: name, spreads: r(meanOf(v), 2) };
    })
    .filter((x) => x.joint !== 'pelvis' && x.spreads !== null)
    .sort((a, b) => b.spreads! - a.spreads!)
    .slice(0, 3);
  return { byPhase, mostDifferentJoints: joints };
}
