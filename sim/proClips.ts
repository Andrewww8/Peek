/**
 * Player CV clips built from the averaged pro templates (with the server's
 * synthetic-clip helpers, server/src/cv/synthetic.ts), plus independent
 * recomputations of what compare_to_reference reports: per-phase deltas and
 * deviation in units of each pro's spread.
 */
import { NJ } from '../server/src/cv/pose';
import { RELEASE_INDEX, SPREAD_FLOOR, decodeRelease, mirror, type CompactRelease, type ReleaseSeries } from '../server/src/cv/release';
import { clipFromCompactTemplate, clipFromTemplate, sweepPoses } from '../server/src/cv/synthetic';
import { writeNpz } from '../server/src/cv/test-pose';
import { LOW_CONFIDENCE_WEIGHT } from '../server/src/coach/calibration';
import type { TemplateRow } from '../server/src/coach/deps';

export { TEMPLATE_CLIP_RELEASE_MS } from '../server/src/cv/synthetic';

/**
 * A player's raw CV npz built from a pro template at one pose of the
 * simulator's distribution (yaw ±40°, scale ±5 %, noise). `flip` mirrors the
 * template, so the player shoots with the pro's other hand.
 */
export function playerNpzFromTemplate(t: TemplateRow, o: { poseSeed: number; flip: boolean }): Buffer {
  const pose = sweepPoses(1, o.poseSeed)[0]!;
  return Buffer.from(writeNpz([{ track: 1, series: clipFromCompactTemplate(t.template, { ...pose, mirrored: o.flip }) }], { fps: 30 }));
}

/**
 * A left-right symmetric player built from a template averaged with its own
 * mirror: neither hand stands out, so hand detection has no confident answer.
 */
export function symmetricPlayerNpz(t: TemplateRow, poseSeed: number): Buffer {
  const a = decodeRelease(t.template);
  const m = mirror(a);
  const pose = new Float32Array(a.pose.length);
  for (let i = 0; i < pose.length; i++) pose[i] = (a.pose[i]! + m.pose[i]!) / 2;
  const series: ReleaseSeries = { ...a, pose, extremities: null, spread: null };
  return Buffer.from(writeNpz([{ track: 1, series: clipFromTemplate(series, sweepPoses(1, poseSeed)[0]!) }], { fps: 30 }));
}

type Curve = (number | null)[];
interface Curves {
  elbow: Curve;
  knee: Curve;
  wristHeight: Curve;
  pelvisRise: Curve;
}
const CURVES = ['elbow', 'knee', 'wristHeight', 'pelvisRise'] as const;
const round = (v: number, d: number) => Number(v.toFixed(d));

/**
 * The per-phase deltas compare_to_reference should report for one shot, from
 * first principles: the shots_averaged-weighted mean pro curve (low-confidence
 * templates down-weighted), phases from that mean knee curve's dip before
 * release, release window = the frames either side of release index 24.
 */
export function expectedPhaseDeltas(player: Curves, templates: TemplateRow[]) {
  const w = templates.map((t) => t.shotsAveraged * (t.lowConfidence ? LOW_CONFIDENCE_WEIGHT : 1));
  const mean = {} as Record<(typeof CURVES)[number], Curve>;
  for (const k of CURVES) {
    mean[k] = templates[0]!.curves[k].map((_, i) => {
      let s = 0, ww = 0;
      templates.forEach((t, j) => {
        const v = t.curves[k][i];
        if (v !== null && v !== undefined) (s += v * w[j]!), (ww += w[j]!);
      });
      return ww > 0 ? round(s / ww, 3) : null;
    });
  }
  const R = RELEASE_INDEX;
  let dip = 0;
  for (let f = 0; f <= R; f++) if (mean.knee[f] !== null && (mean.knee[dip] === null || mean.knee[f]! < mean.knee[dip]!)) dip = f;
  const last = mean.knee.length - 1;
  const ranges = { load: [0, dip], rise: [dip, R - 1], release: [R - 1, Math.min(last, R + 1)], followThrough: [R, last] } as const;
  const out: Record<string, Record<string, number | null>> = {};
  for (const [phase, [a, b]] of Object.entries(ranges)) {
    out[phase] = {};
    for (const k of CURVES) {
      const d: number[] = [];
      for (let f = a; f <= b; f++) {
        const x = player[k][f], y = mean[k][f];
        if (x !== null && x !== undefined && y !== null && y !== undefined) d.push(x - y);
      }
      out[phase]![k] = d.length ? round(d.reduce((p, q) => p + q, 0) / d.length, k === 'elbow' || k === 'knee' ? 1 : 3) : null;
    }
  }
  return out;
}

/** Phase frame ranges from a knee curve's dip before release index 24. */
function phaseWindows(knee: Curve) {
  const R = RELEASE_INDEX;
  let dip = 0;
  for (let f = 0; f <= R; f++) if (knee[f] !== null && (knee[dip] === null || knee[f]! < knee[dip]!)) dip = f;
  const last = knee.length - 1;
  return { load: [0, dip], rise: [dip, R - 1], release: [R - 1, Math.min(last, R + 1)], followThrough: [R, last] } as const;
}

/**
 * Joint deviation from a pro in units of the pro's own joint_spread (floored
 * at SPREAD_FLOOR), averaged per phase of that pro's knee curve, both shots
 * mirrored to right-handed first (left-handers through mirror() directly).
 */
export function expectedSpreadDeviation(playerCompact: CompactRelease, t: TemplateRow): Record<string, number | null> | null {
  const right = (s: ReleaseSeries) => (s.hand === 'left' ? mirror(s) : s);
  const player = right(decodeRelease(playerCompact));
  const pro = right(decodeRelease(t.template));
  if (!pro.spread) return null;
  const frames = (s: ReleaseSeries) => s.pose.length / (NJ * 3);
  const N = Math.min(frames(player), frames(pro));
  const out: Record<string, number | null> = {};
  for (const [phase, [a, b]] of Object.entries(phaseWindows(t.curves.knee))) {
    const v: number[] = [];
    for (let f = a; f <= Math.min(b, N - 1); f++) {
      for (let j = 1; j < NJ; j++) {
        const i = (f * NJ + j) * 3;
        const d = Math.hypot(player.pose[i]! - pro.pose[i]!, player.pose[i + 1]! - pro.pose[i + 1]!, player.pose[i + 2]! - pro.pose[i + 2]!);
        const x = d / Math.max(pro.spread[f * NJ + j]!, SPREAD_FLOOR);
        if (Number.isFinite(x)) v.push(x);
      }
    }
    out[phase] = v.length ? round(v.reduce((p, q) => p + q, 0) / v.length, 2) : null;
  }
  return out;
}
