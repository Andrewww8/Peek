import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { analyzeSeries } from '../cv/metrics.js';
import { NJ, J } from '../cv/pose.js';
import {
  CURVE_KEYS,
  NE,
  computeReleaseMetrics,
  curveDistance,
  decodeRelease,
  mirror,
  phaseDeltas,
  rightHanded,
  spreadDeviation,
} from '../cv/release.js';
import { buildTemplateRecord, readTemplate, type TemplateRecord } from '../cv/templates.js';
import { encodeNpy } from '../cv/test-pose.js';
import { clipFromTemplate } from '../cv/synthetic.js';
import { zipSync } from 'fflate';
import { NpzError } from '../cv/npz.js';
import { createLocalDeps } from '../local/index.js';
import { paths } from '../deps.js';
import { compareToPros, phasesFromKnee, playerComparable, rankPros, templateSeries, type PlayerComparable } from './compare.js';
import type { TemplateRow } from './deps.js';
import { PRO_BASELINES } from './pro-baselines.generated.js';
import { renderThresholds } from './skill.js';
import { createCoachTools } from './tools.js';
import { GENERATED_FILE, renderCalibration } from '../../scripts/calibrate-coach.js';
import { ingestTemplates, DEFAULT_TEMPLATE_DIR } from '../../scripts/reference-templates-ingest.js';

const DIR = DEFAULT_TEMPLATE_DIR;
let records: TemplateRecord[] = [];
const rowOf = (r: TemplateRecord): TemplateRow => ({ ...r, createdAt: 't', updatedAt: 't' });
const byName = (player: string, shotType: string) => records.find((r) => r.player === player && r.shotType === shotType)!;

before(async () => {
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.npz')).sort();
  records = await Promise.all(files.map(async (f) => buildTemplateRecord(await readFile(join(DIR, f)), f)));
});

describe('averaged pro shot templates', () => {
  test('all 20 files parse, with the expected players, shot types and flags', async () => {
    assert.equal(records.length, 20);
    assert.equal(records.filter((r) => r.shotType === 'three_point').length, 10);
    assert.equal(records.filter((r) => r.shotType === 'midrange').length, 10);
    assert.deepEqual(records.filter((r) => r.shootingHand === 'left').map((r) => r.player), ['Luke Kennard', 'Luke Kennard']);
    assert.deepEqual(records.filter((r) => r.lowConfidence).map((r) => `${r.player} ${r.shotType}`), ['Luke Kennard midrange']);
    assert.deepEqual(records.filter((r) => r.uncertainDistance).map((r) => `${r.player} ${r.shotType}`).sort(), ['Luka Doncic three_point', 'Shai Gilgeous-Alexander three_point']);
    assert.equal(byName('Stephen Curry', 'three_point').shotsAveraged, 96);
    for (const r of records) assert.ok(Buffer.byteLength(JSON.stringify(r)) < 64 * 1024, `${r.sourceFile} record size`);
  });

  test('pro metrics land in sane ranges (table printed for the report)', () => {
    const rows = records.map((r) => {
      const m = r.metrics;
      return `${r.sourceFile.replace('.npz', '').padEnd(34)} ${String(m.releaseElbowDeg).padStart(6)} ${String(m.kneeDipDeg).padStart(6)} ${String(m.releaseHeight).padStart(6)} ${String(m.followThroughHoldMs).padStart(4)} ${String(m.pelvisRisePeak).padStart(6)} ${String(m.wristSnapDeg).padStart(5)}`;
    });
    console.log(`# template                           relElb  knee  relHt hold  rise   snap\n# ${rows.join('\n# ')}`);
    for (const r of records) {
      const m = r.metrics;
      assert.ok(m.releaseElbowDeg! > 100 && m.releaseElbowDeg! < 170, `${r.sourceFile} release elbow ${m.releaseElbowDeg}`);
      assert.ok(m.kneeDipDeg! > 90 && m.kneeDipDeg! < 165, `${r.sourceFile} knee ${m.kneeDipDeg}`);
      assert.ok(m.releaseHeight! > -0.05 && m.releaseHeight! < 0.2, `${r.sourceFile} release height ${m.releaseHeight}`);
      assert.ok(m.followThroughHoldMs! >= 0 && m.followThroughHoldMs! <= 400);
      assert.ok(m.pelvisRisePeak! >= 0.09 && m.pelvisRisePeak! <= 0.3, `${r.sourceFile} rise ${m.pelvisRisePeak}`);
      assert.ok(m.wristSnapDeg! >= 0 && m.wristSnapDeg! < 90, `${r.sourceFile} snap ${m.wristSnapDeg}`);
      assert.ok(m.dipToReleaseMs! > 0 && m.dipToReleaseMs! <= 800);
      assert.ok(m.stanceWidth !== null && m.footTurnDeg !== null, 'extremity metrics are present for templates');
    }
    // Styles differ: the stated peak pelvis rise extremes.
    assert.equal(byName('Ray Allen', 'three_point').metrics.pelvisRisePeak, Math.max(...records.map((r) => r.metrics.pelvisRisePeak!)));
  });

  test('the compact template round-trips and canonicalization keeps the delivered frame (shooter faces −z, x right→left)', () => {
    for (const r of records) {
      const s = decodeRelease(r.template);
      const f = 24;
      const g = (j: number, d: number) => s.pose[(f * NJ + j) * 3 + d]!;
      assert.ok(g(J.l_shoulder, 0) - g(J.r_shoulder, 0) > 0.1, `${r.sourceFile}: left shoulder at +x`);
      assert.ok(g(J.head, 1) < -0.3, `${r.sourceFile}: head up (−y)`);
      assert.deepEqual(computeReleaseMetrics(s), r.metrics, 'metrics recompute from the stored template');
    }
  });

  test('Kennard (left-handed) mirrors correctly', () => {
    const k = decodeRelease(byName('Luke Kennard', 'three_point').template);
    assert.equal(k.hand, 'left');
    const m = mirror(k);
    assert.equal(m.hand, 'right');
    for (let f = 0; f < 37; f++) {
      for (const [right, left] of [[J.r_wrist, J.l_wrist], [J.r_knee, J.l_knee], [J.r_shoulder, J.l_shoulder]]) {
        assert.equal(m.pose[(f * NJ + right!) * 3]!, -k.pose[(f * NJ + left!) * 3]!);
        assert.equal(m.pose[(f * NJ + right!) * 3 + 1]!, k.pose[(f * NJ + left!) * 3 + 1]!);
      }
      // extremities: r_middle_tip (1) ↔ l_middle_tip (0)
      assert.equal(m.extremities![(f * NE + 1) * 3]!, -k.extremities![(f * NE + 0) * 3]!);
      assert.equal(m.spread![f * NJ + J.r_wrist]!, k.spread![f * NJ + J.l_wrist]!);
    }
    assert.deepEqual(computeReleaseMetrics(m), computeReleaseMetrics(k), 'hand-aware metrics are mirror-invariant');
    assert.deepEqual(mirror(m).pose, k.pose, 'mirroring twice is the identity');
    // After mirroring, the shooting wrist is the right one and is above the head at release.
    const R = 24;
    assert.ok(m.pose[(R * NJ + J.head) * 3 + 1]! - m.pose[(R * NJ + J.r_wrist) * 3 + 1]! > 0);
  });

  test('rejects files that are not templates, or on another grid', () => {
    const tiny = zipSync({ 'release_index.npy': encodeNpy('<i8', [], new Uint8Array(new BigInt64Array([10n]).buffer)), 't_seconds.npy': encodeNpy('<f8', [1], new Uint8Array(8)) });
    assert.throws(() => readTemplate(tiny), NpzError);
    assert.throws(() => readTemplate(zipSync({ 'a.npy': encodeNpy('<f4', [1], new Uint8Array(4)) })), /not an averaged-shot template/);
  });
});

/** A player's comparable view straight from a template (as if the player shot exactly like that pro). */
const asPlayer = (r: TemplateRecord): PlayerComparable => ({ hand: r.shootingHand, shots: [1], handUncertainShots: [], metrics: r.metrics, curves: r.curves, series: rightHanded(decodeRelease(r.template)) });

describe('comparison with the pros', () => {
  test('a template compared with itself: zero curve deltas and zero deviation, and it ranks itself closest', () => {
    for (const r of records) {
      const rows = records.filter((x) => x.shotType === r.shotType).map(rowOf);
      const p = asPlayer(r);
      const ranked = rankPros(p, rows, PRO_BASELINES[r.shotType]!);
      assert.equal(ranked[0]!.player, r.player, `${r.sourceFile} ranks itself first`);
      assert.equal(ranked[0]!.similarity, 0);
      const self = templateSeries(rowOf(r));
      const dev = spreadDeviation(p.series, self, phasesFromKnee(r.curves.knee))!;
      for (const v of Object.values(dev.byPhase)) assert.equal(v, 0);
      const ph = phaseDeltas(r.curves, r.curves, phasesFromKnee(r.curves.knee));
      for (const phase of Object.values(ph)) for (const v of Object.values(phase)) assert.equal(v, 0);
      assert.equal(curveDistance(r.curves, r.curves, PRO_BASELINES[r.shotType]!.curveScales).score, 0);
    }
  });

  test('a synthetic player clip through the full clip pipeline ranks the pro it was built from first (incl. a left-hander)', () => {
    // Pros whose shooting hand is clearly separated in the averaged pose (see the hand-detection test).
    for (const [name, type] of [['Kyrie Irving', 'three_point'], ['Luke Kennard', 'three_point'], ['Stephen Curry', 'midrange']] as const) {
      const pro = byName(name, type);
      const clip = clipFromTemplate(decodeRelease(pro.template), { yawDeg: 35, scale: 1.03, noise: 0.004, seed: 7 });
      const a = analyzeSeries(clip, 1, { taggedReleaseFrame: 24 + 30, windowStart: 0, windowEnd: clip.frames.at(-1)!, cuts: [] });
      assert.ok(a.comparison, 'the clip has a pro comparison');
      assert.equal(a.metrics.shootingHand, pro.shootingHand);
      const rows = [{ userId: 'u', sessionId: 's', shotNumber: 1, shotType: type, releaseMs: 0, outcome: 'made', clipPathname: null, startMs: 0, endMs: 0, sizeBytes: 0, analysisStatus: 'complete', analysis: a, mediaDeletedAt: null, createdAt: 't', updatedAt: 't' }] as never;
      const player = playerComparable(rows)!;
      const cmp = compareToPros(player, records.filter((r) => r.shotType === type).map(rowOf), PRO_BASELINES[type]!);
      assert.equal(cmp.closestPros[0]!.player, name, `${name}: ranked ${cmp.closestPros.map((p) => `${p.player} ${p.similarity}`).join(', ')}`);
      assert.equal(cmp.closestPros[0]!.mirrored, false);
      assert.ok(Math.abs(a.comparison!.metrics.kneeDipDeg! - pro.metrics.kneeDipDeg!) < 5, 'same knee dip within noise');
    }
  });

  test('shooting-hand detection on clips made from all 20 templates: at least 18 right (averaged shots are nearly symmetric)', () => {
    const wrong: string[] = [];
    for (const r of records) {
      const clip = clipFromTemplate(decodeRelease(r.template), { yawDeg: 0, scale: 1, noise: 0, seed: 1 });
      const a = analyzeSeries(clip, 1, { taggedReleaseFrame: 54, windowStart: 0, windowEnd: clip.frames.at(-1)!, cuts: [] });
      if (a.metrics.shootingHand !== r.shootingHand) wrong.push(r.sourceFile);
    }
    console.log(`# hand detection misses on averaged templates: ${wrong.join(', ') || 'none'}`);
    assert.ok(wrong.length <= 2, wrong.join(', '));
  });
});

describe('calibration', () => {
  test('is deterministic and matches the committed generated file', async () => {
    const a = await renderCalibration();
    const b = await renderCalibration();
    assert.equal(a, b);
    assert.equal(a, await readFile(GENERATED_FILE, 'utf8'), 'run `npm run calibrate-coach -w server` and commit the result');
  });

  test('baselines weight by shots averaged and down-weight low-confidence templates; the skill shows the generated numbers', () => {
    for (const type of ['three_point', 'midrange']) {
      const b = PRO_BASELINES[type]!;
      assert.equal(b.templates, 10);
      const rise = b.metrics.pelvisRisePeak!;
      assert.ok(rise.min >= 0.1 && rise.max <= 0.29 && rise.sd > 0);
      const text = renderThresholds(type);
      assert.ok(text.includes(`| releaseElbowDeg |`) && text.includes(`${b.metrics.releaseElbowDeg!.mean} ± ${b.metrics.releaseElbowDeg!.sd}`));
    }
    // Kennard midrange (5 shots, low confidence) barely moves the stance mean despite its outlier 1.88.
    const mid = records.filter((r) => r.shotType === 'midrange');
    const plain = mid.reduce((a, r) => a + r.metrics.stanceWidth!, 0) / mid.length;
    assert.ok(PRO_BASELINES.midrange!.metrics.stanceWidth!.mean < plain);
  });
});

describe('ingest and coach tools', () => {
  test('ingest is idempotent: one row per (player, shot type)', async () => {
    const deps = createLocalDeps(join(tmpdir(), `perspective-tpl-${randomUUID()}`), { jwtSecret: 's', inMemory: true });
    await ingestTemplates(deps.references);
    const first = await deps.references.listTemplates();
    await ingestTemplates(deps.references);
    const again = await deps.references.listTemplates();
    assert.equal(again.length, 20);
    assert.deepEqual(again.map((t) => t.createdAt), first.map((t) => t.createdAt));
    assert.equal((await deps.references.listTemplates('midrange')).length, 10);
  });

  test("tools only return templates of the session's shot type", async () => {
    const deps = createLocalDeps(join(tmpdir(), `perspective-tpl-${randomUUID()}`), { jwtSecret: 's', inMemory: true });
    const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const S = randomUUID();
    const pro = byName('Stephen Curry', 'midrange');
    const clip = clipFromTemplate(decodeRelease(pro.template), { yawDeg: -20, scale: 1, noise: 0.003, seed: 3 });
    const analysis = analyzeSeries(clip, 1, { taggedReleaseFrame: 54, windowStart: 0, windowEnd: clip.frames.at(-1)!, cuts: [] });
    await deps.clips.upsert({ userId: A, sessionId: S, shotNumber: 1, shotType: 'midrange', releaseMs: 1800, outcome: 'made', clipPathname: paths.clip(A, S, 1), startMs: 0, endMs: 4000, sizeBytes: 1 });
    await deps.clips.setAnalysis(A, S, 1, 'complete', analysis);
    const tools: Record<string, { invoke: (a: object, c: unknown) => Promise<unknown> }> = Object.fromEntries(createCoachTools({ clips: deps.clips, references: deps.references }).map((t) => [t.name, t as never]));
    const run = async (name: string, args: object = {}) => JSON.parse(String(await tools[name]!.invoke(args, { context: { userId: A, sessionId: S } } as never)));

    assert.deepEqual(await run('compare_to_reference'), { available: false, shotType: 'midrange', reason: 'No pro templates for this shot type yet.' });
    await ingestTemplates(deps.references);
    const list = await run('list_pro_references');
    assert.equal(list.shotType, 'midrange');
    assert.equal(list.pros.length, 10);
    assert.deepEqual((await run('list_pro_references', { shotType: 'three_point' })).error, 'shot_type_mismatch');
    const kennard = list.pros.find((p: { player: string }) => p.player === 'Luke Kennard');
    assert.deepEqual([kennard.lowConfidence, kennard.shotsAveraged], [true, 5]);

    const cmp = await run('compare_to_reference', { shotNumber: 1 });
    assert.equal(cmp.available, true);
    assert.equal(cmp.closestPros[0].player, 'Stephen Curry');
    assert.equal(cmp.closestPros.length, 3);
    assert.ok(cmp.closestPros.every((p: { player: string }) => records.some((r) => r.player === p.player && r.shotType === 'midrange')));
    assert.ok(cmp.metrics.kneeDipDeg && typeof cmp.metrics.kneeDipDeg.z === 'number');
    assert.deepEqual(Object.keys(cmp.phases).filter((k) => k !== 'note'), ['load', 'rise', 'release', 'followThrough']);
    assert.ok(cmp.closestPros[0].spreadDeviation.byPhase.load !== null);
    assert.deepEqual(cmp.reliability.lowConfidencePros, ['Luke Kennard']);
    assert.equal((await run('compare_to_reference')).target, 'session');

    const similar = await run('find_similar_pros');
    assert.equal(similar.closest[0].player, 'Stephen Curry');
    assert.equal(similar.closest.length + similar.others.length, 10);

    const profile = await run('get_pro_profile', { player: 'Curry' });
    assert.deepEqual([profile.player, profile.shotType, profile.reliability.shotsAveraged], ['Stephen Curry', 'midrange', 13]);
    assert.ok(typeof profile.metrics.releaseElbowDeg.z === 'number');
    assert.equal((await run('get_pro_profile', { player: 'Curry', shotType: 'three_point' })).error, 'shot_type_mismatch');
    assert.equal((await run('get_pro_profile', { player: 'Jordan' })).error, 'pro_not_found');
    for (const k of CURVE_KEYS) assert.ok(k in similar.closest[0].curveRmse);
  });
});
