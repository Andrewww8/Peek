/**
 * Player-vs-pro comparison on the pro-comparable (release-aligned) view.
 * Everything is converted to right-handed first, so a left-handed shooter is
 * compared with mirrored right-handed templates and vice versa.
 */
import { recompute, type ShotAnalysis } from '../cv/metrics.js';
import {
  CURVE_KEYS,
  PHASES,
  RELEASE_INDEX,
  RELEASE_METRIC_KEYS,
  curveDistance,
  decodeRelease,
  phaseDeltas,
  rightHanded,
  spreadDeviation,
  type Curves,
  type Hand,
  type ReleaseMetricKey,
  type ReleaseMetrics,
  type ReleaseSeries,
} from '../cv/release.js';
import type { ClipRow } from '../deps.js';
import { weightOf, type ShotTypeBaseline } from './calibration.js';
import type { TemplateRow } from './deps.js';

export interface PlayerComparable {
  hand: Hand;
  shots: number[];
  /** Compared shots whose hand was detected with low confidence and not declared. */
  handUncertainShots: number[];
  metrics: Partial<ReleaseMetrics>;
  curves: Curves;
  /** Right-handed canonical pose (single shot, or the per-frame mean of the session's shots). */
  series: ReleaseSeries;
}

const meanOrNull = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (v: number | null, d: number) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/** The session's shot type: the most common one among its clips. */
export function sessionShotType(rows: ClipRow[]): string | null {
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.shotType, (count.get(r.shotType) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

export const HAND_NOTE =
  "The shooting hand was detected with low confidence and the player hasn't declared it. Ask the player which hand they shoot with; mirrored comparisons would be wrong if it's the other one.";

/**
 * A shot's analysis as the coach should see it: re-derived from the stored compact pose when the
 * player declared a hand after the analysis ran (or the analysis predates hand info / comparisons).
 */
export function effectiveAnalysis(r: ClipRow): ShotAnalysis | null {
  if (r.analysisStatus !== 'complete' || !r.analysis) return null;
  const a = r.analysis as ShotAnalysis;
  const declared = r.shootingHand ?? undefined;
  const stale = (declared && a.hand?.value !== declared) || (declared && a.hand?.source !== 'declared') || !a.hand || a.comparison === undefined;
  if (!stale || !a.pose || !a.input) return a;
  const input = { ...a.input, ...(declared ? { declaredHand: declared } : {}) };
  return { ...a, ...recompute({ pose: a.pose, input }) };
}

/** Whether the coach should ask the player for their shooting hand. */
export const handUncertain = (a: ShotAnalysis | null) => !!a?.hand && a.hand.source === 'detected' && a.hand.confidence === 'low';

function comparisonOf(r: ClipRow) {
  const a = effectiveAnalysis(r);
  if (!a || (a.quality && a.quality.usable === false)) return null;
  return a.comparison ?? null;
}

/** One shot's, or the usable shots' average, pro-comparable view. Null when nothing is comparable. */
export function playerComparable(rows: ClipRow[], shotNumber?: number): PlayerComparable | null {
  const picked = rows.filter((r) => shotNumber === undefined || r.shotNumber === shotNumber);
  const comps = picked.flatMap((r) => {
    const c = comparisonOf(r);
    return c ? [{ shot: r.shotNumber, c, series: rightHanded(decodeRelease(c.series)) }] : [];
  });
  if (!comps.length) return null;
  const metrics: Partial<ReleaseMetrics> = {};
  for (const k of RELEASE_METRIC_KEYS) {
    const v = meanOrNull(comps.map((x) => x.c.metrics[k]).filter((x): x is number => x !== null));
    if (v !== null) metrics[k] = round(v, /Deg$|Ms$/.test(k) ? 1 : 3)!;
  }
  const first = comps[0]!;
  const avgCurve = (k: (typeof CURVE_KEYS)[number]) =>
    first.c.curves[k].map((_, i) => round(meanOrNull(comps.map((x) => x.c.curves[k][i]).filter((v): v is number => v !== null && v !== undefined)), 3));
  const curves: Curves = { tSeconds: first.c.curves.tSeconds, elbow: avgCurve('elbow'), knee: avgCurve('knee'), wristHeight: avgCurve('wristHeight'), pelvisRise: avgCurve('pelvisRise'), spread: null };
  const pose = new Float32Array(first.series.pose.length);
  for (let i = 0; i < pose.length; i++) {
    const v = comps.map((x) => x.series.pose[i]!).filter(Number.isFinite);
    pose[i] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  }
  return {
    hand: first.c.series.hand,
    shots: comps.map((x) => x.shot),
    handUncertainShots: picked.filter((r) => comps.some((x) => x.shot === r.shotNumber) && handUncertain(effectiveAnalysis(r))).map((r) => r.shotNumber),
    metrics,
    curves,
    series: { ...first.series, pose, hand: 'right' },
  };
}

export const templateSeries = (t: TemplateRow) => rightHanded(decodeRelease(t.template));

/** Templates ranked by normalized curve RMSE (lower = more similar). */
export function rankPros(player: PlayerComparable, templates: TemplateRow[], baseline: ShotTypeBaseline) {
  return templates
    .map((t) => {
      const d = curveDistance(player.curves, t.curves, baseline.curveScales);
      return {
        player: t.player,
        shootingHand: t.shootingHand,
        mirrored: t.shootingHand !== player.hand,
        similarity: d.score,
        curveRmse: d.perCurve,
        shotsAveraged: t.shotsAveraged,
        lowConfidence: t.lowConfidence,
        uncertainDistance: t.uncertainDistance,
        template: t,
      };
    })
    .filter((x) => x.similarity !== null)
    .sort((a, b) => a.similarity! - b.similarity! || (a.player < b.player ? -1 : 1));
}

/** The shots_averaged-weighted mean pro curve of a shot type. */
export function meanProCurves(templates: TemplateRow[]): Curves {
  const w = templates.map(weightOf);
  const curve = (k: (typeof CURVE_KEYS)[number]) =>
    templates[0]!.curves[k].map((_, i) => {
      let s = 0, ww = 0;
      templates.forEach((t, j) => {
        const v = t.curves[k][i];
        if (v !== null && v !== undefined) (s += v * w[j]!), (ww += w[j]!);
      });
      return ww > 0 ? round(s / ww, 3) : null;
    });
  return { tSeconds: templates[0]!.curves.tSeconds, elbow: curve('elbow'), knee: curve('knee'), wristHeight: curve('wristHeight'), pelvisRise: curve('pelvisRise'), spread: null };
}

/** Phase frame ranges from a knee curve's dip (min before release). */
export function phasesFromKnee(knee: (number | null)[], releaseIndex = RELEASE_INDEX) {
  let dip = 0;
  for (let f = 0; f <= releaseIndex; f++) if (knee[f] !== null && (knee[dip] === null || knee[f]! < knee[dip]!)) dip = f;
  const last = knee.length - 1;
  return { load: [0, dip], rise: [dip, releaseIndex - 1], release: [releaseIndex - 1, Math.min(last, releaseIndex + 1)], followThrough: [releaseIndex, last] } as Record<(typeof PHASES)[number], [number, number]>;
}

export function metricZ(metrics: Partial<ReleaseMetrics>, baseline: ShotTypeBaseline) {
  const out: Partial<Record<ReleaseMetricKey, { player: number; proMean: number; proSd: number; proMin: number; proMax: number; z: number; withinProRange: boolean }>> = {};
  for (const k of RELEASE_METRIC_KEYS) {
    const v = metrics[k], b = baseline.metrics[k];
    if (v === null || v === undefined || !b) continue;
    out[k] = { player: v, proMean: b.mean, proSd: b.sd, proMin: b.min, proMax: b.max, z: Number(((v - b.mean) / b.sd).toFixed(2)), withinProRange: v >= b.min && v <= b.max };
  }
  return out;
}

export function compareToPros(player: PlayerComparable, templates: TemplateRow[], baseline: ShotTypeBaseline, top = 3) {
  const ranked = rankPros(player, templates, baseline);
  const mean = meanProCurves(templates);
  const closest = ranked.slice(0, top).map(({ template, ...rest }) => {
    const pro = templateSeries(template);
    return { ...rest, spreadDeviation: spreadDeviation(player.series, pro, phasesFromKnee(template.curves.knee)) };
  });
  return {
    metrics: metricZ(player.metrics, baseline),
    phases: { note: "Mean (player − pro average) per phase; angles in degrees, heights in body heights.", ...phaseDeltas(player.curves, mean, phasesFromKnee(mean.knee)) },
    closestPros: closest,
  };
}
