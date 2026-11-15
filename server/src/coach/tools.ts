/**
 * The coach's tools. Every number the coach uses comes from here. All tools are
 * read-only and return small JSON. The player and session always come from the
 * runtime context set by the authenticated request, never from tool arguments:
 * the schemas have no user or session field, and zod strips any the model adds.
 */
import { tool } from 'langchain';
import { z } from 'zod';
import type { ClipRepo, ClipRow } from '../deps.js';
import type { ShotAnalysis, ShotMetrics } from '../cv/metrics.js';
import { PRO_BASELINES } from './pro-baselines.generated.js';
import { HAND_NOTE, compareToPros, effectiveAnalysis, handUncertain, metricZ, playerComparable, rankPros, sessionShotType } from './compare.js';
import type { ReferenceRepo, TemplateRow } from './deps.js';

export const coachContextSchema = z.object({ userId: z.string(), sessionId: z.string() });
export type CoachContext = z.infer<typeof coachContextSchema>;

/** Numeric metrics the tools compare. */
export const METRIC_KEYS = [
  'elbowAngleSetPointDeg',
  'elbowAngleReleaseDeg',
  'kneeFlexionMinDeg',
  'dipToReleaseMs',
  'releaseHeightRatio',
  'trunkLeanDeg',
  'elbowFlareRatio',
  'followThroughHoldMs',
  'jumpRiseRatio',
  'ankleSpreadRatio',
  'pelvisDriftRatio',
] as const satisfies readonly (keyof ShotMetrics)[];
type MetricKey = (typeof METRIC_KEYS)[number];

const ctx = (runtime: unknown): CoachContext => coachContextSchema.parse((runtime as { context?: unknown })?.context);
const analysisOf = (r: ClipRow) => (r.analysisStatus === 'complete' && r.analysis ? (r.analysis as ShotAnalysis) : null);
const usable = (r: ClipRow) => {
  const a = analysisOf(r);
  return a && a.quality?.usable ? a : null;
};
const avg = (xs: number[]) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : null);
const valuesOf = (rows: ClipRow[], key: MetricKey) =>
  rows.map((r) => usable(r)?.metrics[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
const json = (v: unknown) => JSON.stringify(v);

/** Labels for the phone's tool_status events. */
export function toolStatus(name: string, args: Record<string, unknown>): { tool: string; message: string } {
  switch (name) {
    case 'get_session_overview':
      return { tool: 'session_overview', message: 'Reviewing your session…' };
    case 'get_shot_metrics':
      return { tool: 'shot_metrics', message: `Looking at shot ${args.shotNumber ?? ''}…`.replace(' …', '…') };
    case 'compare_made_vs_missed':
      return { tool: 'made_vs_missed', message: 'Comparing your makes and misses…' };
    case 'get_shot_timeseries':
      return { tool: 'shot_timeseries', message: `Tracing shot ${args.shotNumber ?? ''} frame by frame…` };
    case 'get_player_history':
      return { tool: 'player_history', message: 'Checking your past sessions…' };
    case 'compare_to_reference':
      return { tool: 'pro_reference', message: 'Comparing with pro shooters…' };
    case 'find_similar_pros':
      return { tool: 'similar_pros', message: 'Finding pros who shoot like you…' };
    case 'list_pro_references':
      return { tool: 'pro_list', message: 'Looking up the pro library…' };
    case 'get_pro_profile':
      return { tool: 'pro_profile', message: `Looking at ${args.player ?? 'a pro'}'s shot…` };
    case 'task':
      return { tool: 'form_analysis', message: 'Analyzing your whole session…' };
    default:
      return { tool: 'coaching_notes', message: 'Checking coaching notes…' };
  }
}

export function createCoachTools(deps: { clips: ClipRepo; references: ReferenceRepo }) {
  const session = async (runtime: unknown) => {
    const c = ctx(runtime);
    return deps.clips.list(c.userId, c.sessionId);
  };
  const shot = async (runtime: unknown, n: number) => (await session(runtime)).find((r) => r.shotNumber === n) ?? null;

  const getSessionOverview = tool(
    async (_input, runtime) => {
      const rows = await session(runtime);
      const made = rows.filter((r) => r.outcome === 'made').length;
      const missed = rows.filter((r) => r.outcome === 'missed').length;
      return json({
        shots: rows.map((r) => ({
          shotNumber: r.shotNumber,
          outcome: r.outcome,
          analysisStatus: r.analysisStatus,
          usable: analysisOf(r)?.quality.usable ?? null,
          warnings: analysisOf(r)?.quality.warnings ?? [],
        })),
        made,
        missed,
        unmarked: rows.length - made - missed,
        makePercent: made + missed ? Math.round((made / (made + missed)) * 100) : null,
        analyzedShots: rows.filter((r) => analysisOf(r)).length,
        pendingShots: rows.filter((r) => r.analysisStatus === 'pending').length,
      });
    },
    { name: 'get_session_overview', description: "This session's shots, outcomes, make percentage, and which shots have form analysis.", schema: z.object({}) },
  );

  const getShotMetrics = tool(
    async ({ shotNumber }, runtime) => {
      const r = await shot(runtime, shotNumber);
      if (!r) return json({ error: 'shot_not_found', shotNumber });
      const a = analysisOf(r) ? effectiveAnalysis(r) : null;
      if (!a) return json({ shotNumber, outcome: r.outcome, analysisStatus: r.analysisStatus, metrics: null });
      return json({
        shotNumber,
        outcome: r.outcome,
        analysisStatus: r.analysisStatus,
        shootingHand: a.hand ? { value: a.hand.value, source: a.hand.source, confidence: a.hand.confidence } : null,
        ...(handUncertain(a) ? { handNote: HAND_NOTE } : {}),
        metrics: a.metrics,
        proComparable: a.comparison?.metrics ?? null,
        quality: a.quality,
      });
    },
    { name: 'get_shot_metrics', description: "One shot's form metrics and data-quality flags.", schema: z.object({ shotNumber: z.number().int().positive() }) },
  );

  const compareMadeVsMissed = tool(
    async (_input, runtime) => {
      const rows = await session(runtime);
      const made = rows.filter((r) => r.outcome === 'made');
      const missed = rows.filter((r) => r.outcome === 'missed');
      const metrics = Object.fromEntries(
        METRIC_KEYS.map((k) => {
          const m = valuesOf(made, k), x = valuesOf(missed, k);
          const madeMean = avg(m), missedMean = avg(x);
          return [k, { madeMean, missedMean, difference: madeMean !== null && missedMean !== null ? Number((madeMean - missedMean).toFixed(3)) : null, madeN: m.length, missedN: x.length }];
        }),
      );
      return json({ note: 'Means over usable analyzed shots only.', metrics });
    },
    { name: 'compare_made_vs_missed', description: 'Per-metric means of made vs missed shots in this session, with sample sizes.', schema: z.object({}) },
  );

  const getShotTimeseries = tool(
    async ({ shotNumber, signal }, runtime) => {
      const r = await shot(runtime, shotNumber);
      const a = r && analysisOf(r);
      if (!a) return json({ error: r ? 'not_analyzed' : 'shot_not_found', shotNumber });
      return json({ shotNumber, signal, tMsRelativeToRelease: a.series.tMs, values: a.series[signal] });
    },
    {
      name: 'get_shot_timeseries',
      description: 'A 10 Hz series (2 s before to 1 s after release) of the shooting elbow angle, knee angle, or wrist height above the head.',
      schema: z.object({ shotNumber: z.number().int().positive(), signal: z.enum(['elbow', 'knee', 'wristHeight']) }),
    },
  );

  const getPlayerHistory = tool(
    async ({ metric }, runtime) => {
      const c = ctx(runtime);
      const all = await deps.clips.list(c.userId);
      const bySession = new Map<string, ClipRow[]>();
      for (const r of all) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
      const sessions = [...bySession].map(([sessionId, rows]) => {
        const vals = valuesOf(rows, metric);
        const made = rows.filter((r) => r.outcome === 'made').length, missed = rows.filter((r) => r.outcome === 'missed').length;
        return {
          sessionId,
          current: sessionId === c.sessionId,
          date: rows.map((r) => r.createdAt).sort()[0]!.slice(0, 10),
          mean: avg(vals),
          n: vals.length,
          makePercent: made + missed ? Math.round((made / (made + missed)) * 100) : null,
        };
      });
      sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return json({ metric, sessions: sessions.slice(-20) });
    },
    { name: 'get_player_history', description: "One metric's mean per session across the player's sessions, oldest first.", schema: z.object({ metric: z.enum(METRIC_KEYS) }) },
  );

  /** The session's shot type and its pro templates; tools never return templates of another shot type. */
  const prosFor = async (runtime: unknown) => {
    const rows = await session(runtime);
    const shotType = sessionShotType(rows);
    const templates = shotType ? await deps.references.listTemplates(shotType) : [];
    const baseline = shotType ? PRO_BASELINES[shotType] : undefined;
    return { rows, shotType, templates, baseline };
  };
  const reliability = (t: Pick<TemplateRow, 'shotsAveraged' | 'lowConfidence' | 'uncertainDistance'>) => ({
    shotsAveraged: t.shotsAveraged,
    lowConfidence: t.lowConfidence,
    uncertainDistance: t.uncertainDistance,
  });
  const NOTE = 'Pro values are data-derived averages of many shots per player (from video); pros differ in style, so the target is the pro range and the closest matches.';
  const target = z.object({ shotNumber: z.number().int().positive().optional().describe('Omit to use the average of the session\'s analyzed shots.') });

  const compareToReference = tool(
    async ({ shotNumber }, runtime) => {
      const { rows, shotType, templates, baseline } = await prosFor(runtime);
      if (!templates.length || !baseline) return json({ available: false, shotType, reason: 'No pro templates for this shot type yet.' });
      if (shotNumber !== undefined && !rows.some((r) => r.shotNumber === shotNumber)) return json({ error: 'shot_not_found', shotNumber });
      const player = playerComparable(rows, shotNumber);
      if (!player) return json({ available: false, shotType, reason: 'No analyzed shot with enough 3D pose to compare yet.' });
      const cmp = compareToPros(player, templates, baseline);
      return json({
        available: true,
        shotType,
        target: shotNumber ?? 'session',
        shotsCompared: player.shots,
        note: NOTE,
        shootingHand: player.hand,
        ...(player.handUncertainShots.length ? { handUncertain: true, handUncertainShots: player.handUncertainShots, handNote: HAND_NOTE } : {}),
        reliability: {
          proTemplates: templates.length,
          lowConfidencePros: templates.filter((t) => t.lowConfidence).map((t) => t.player),
          uncertainDistancePros: templates.filter((t) => t.uncertainDistance).map((t) => t.player),
          playerShots: player.shots.length,
        },
        ...cmp,
      });
    },
    {
      name: 'compare_to_reference',
      description:
        "Compares one shot (or the session's average) with the averaged pro templates of the session's shot type: metric z-scores against the pro range, per-phase curve differences (load, rise, release, follow-through), deviation in units of each pro's own consistency, and the 3 closest-matching pros. Metrics only, never video.",
      schema: target,
    },
  );

  const findSimilarPros = tool(
    async ({ shotNumber }, runtime) => {
      const { rows, shotType, templates, baseline } = await prosFor(runtime);
      if (!templates.length || !baseline) return json({ available: false, shotType, reason: 'No pro templates for this shot type yet.' });
      const player = playerComparable(rows, shotNumber);
      if (!player) return json({ available: false, shotType, reason: 'No analyzed shot with enough 3D pose to compare yet.' });
      const ranked = rankPros(player, templates, baseline).map(({ template, ...r }) => r);
      return json({
        available: true,
        shotType,
        target: shotNumber ?? 'session',
        note: 'Lower similarity = closer shot shape (normalized curve RMSE).',
        shootingHand: player.hand,
        ...(player.handUncertainShots.length ? { handUncertain: true, handNote: HAND_NOTE } : {}),
        closest: ranked.slice(0, 3),
        others: ranked.slice(3).map((r) => r.player),
      });
    },
    { name: 'find_similar_pros', description: "The pros whose averaged shot shape is closest to this shot's (or the session's), handedness-aware.", schema: target },
  );

  const shotTypeArg = z.object({ shotType: z.string().optional().describe("Defaults to the session's shot type; other shot types are not available.") });
  const checkType = (asked: string | undefined, shotType: string | null) => (asked && asked !== shotType ? json({ error: 'shot_type_mismatch', sessionShotType: shotType }) : null);

  const listProReferences = tool(
    async ({ shotType: asked }, runtime) => {
      const { shotType, templates } = await prosFor(runtime);
      const mismatch = checkType(asked, shotType);
      if (mismatch) return mismatch;
      return json({ shotType, note: NOTE, pros: templates.map((t) => ({ player: t.player, shootingHand: t.shootingHand, ...reliability(t) })) });
    },
    { name: 'list_pro_references', description: "The pro templates available for the session's shot type, with how many shots each averages and reliability flags.", schema: shotTypeArg },
  );

  const getProProfile = tool(
    async ({ player, shotType: asked }, runtime) => {
      const { shotType, templates, baseline } = await prosFor(runtime);
      const mismatch = checkType(asked, shotType);
      if (mismatch) return mismatch;
      const q = player.trim().toLowerCase();
      const t = templates.find((x) => x.player.toLowerCase() === q) ?? templates.find((x) => x.player.toLowerCase().split(' ').includes(q));
      if (!t) return json({ error: 'pro_not_found', player, available: templates.map((x) => x.player) });
      return json({
        player: t.player,
        shotType,
        shootingHand: t.shootingHand,
        note: NOTE,
        reliability: reliability(t),
        metrics: baseline ? metricZ(t.metrics, baseline) : t.metrics,
      });
    },
    { name: 'get_pro_profile', description: "One pro's averaged shot for the session's shot type: metrics against the pro range, and reliability.", schema: z.object({ player: z.string() }).merge(shotTypeArg) },
  );

  return [getSessionOverview, getShotMetrics, compareMadeVsMissed, getShotTimeseries, getPlayerHistory, compareToReference, findSimilarPros, listProReferences, getProProfile];
}
