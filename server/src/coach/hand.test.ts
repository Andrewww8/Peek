import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSweep, loadRecords, sweep } from '../../scripts/pro-sweep.js';
import { ingestTemplates } from '../../scripts/reference-templates-ingest.js';
import { analyzeSeries, recompute } from '../cv/metrics.js';
import { TEMPLATE_CLIP_RELEASE_FRAME, TEMPLATE_CLIP_RELEASE_MS, clipFromCompactTemplate, sweepPoses } from '../cv/synthetic.js';
import type { TemplateRecord } from '../cv/templates.js';
import { paths } from '../deps.js';
import { createLocalDeps } from '../local/index.js';
import { HAND_NOTE } from './compare.js';
import { createCoachTools } from './tools.js';

let records: TemplateRecord[] = [];
before(async () => {
  records = await loadRecords();
});
const find = (player: string, shotType: string) => records.find((r) => r.player === player && r.shotType === shotType)!;
const analyze = (r: TemplateRecord, o: { mirrored?: boolean; declaredHand?: 'right' | 'left'; seed?: number } = {}) => {
  const [pose] = sweepPoses(1, o.seed ?? 11);
  const clip = clipFromCompactTemplate(r.template, { ...pose!, mirrored: o.mirrored });
  return analyzeSeries(clip, 1, { taggedReleaseFrame: TEMPLATE_CLIP_RELEASE_FRAME, windowStart: 0, windowEnd: clip.frames.at(-1)!, cuts: [], ...(o.declaredHand ? { declaredHand: o.declaredHand } : {}) });
};

describe('shooting hand', () => {
  test('sweep: every template, both hands, detects the hand and ranks itself first', () => {
    const rows = sweep(records, 8, 4242);
    console.log(`# pro sweep (8 poses):\n# ${formatSweep(rows).split('\n').join('\n# ')}`);
    for (const r of rows) {
      assert.equal(r.handRight, r.trials, `${r.source}${r.mirrored ? ' mirrored' : ''}: hand ${r.handRight}/${r.trials}`);
      assert.equal(r.selfFirst, r.trials, `${r.source}${r.mirrored ? ' mirrored' : ''}: self first ${r.selfFirst}/${r.trials}`);
    }
  });

  test('a declared hand wins over detection, and both are recorded', () => {
    const a = analyze(find('Stephen Curry', 'three_point'), { declaredHand: 'left' });
    assert.deepEqual([a.hand.value, a.hand.source, a.hand.detected, a.metrics.shootingHand], ['left', 'declared', 'right', 'left']);
    assert.equal(a.input.declaredHand, 'left');
    assert.deepEqual(recompute(a).hand, a.hand, 'recompute keeps the declared hand');
    const d = analyze(find('Stephen Curry', 'three_point'));
    assert.deepEqual([d.hand.value, d.hand.source, d.hand.confidence], ['right', 'detected', 'high']);
    assert.ok(d.hand.score > 0.5);
    assert.ok(Object.keys(d.hand.evidence).length === 5);
  });

  test('near-symmetric averaged shots are flagged low-confidence instead of guessed silently', () => {
    const a = analyze(find('Ray Allen', 'midrange'));
    assert.equal(a.hand.value, 'right');
    assert.equal(a.hand.confidence, 'low');
  });

  test('the coach is told to ask when detection is unsure and nothing was declared; declaring later re-derives the analysis', async () => {
    const deps = createLocalDeps(join(tmpdir(), `perspective-hand-${randomUUID()}`), { jwtSecret: 's', inMemory: true });
    await ingestTemplates(deps.references);
    const A = 'aaaaaaaa-0000-4000-8000-00000000000a', S = randomUUID();
    const pro = find('Ray Allen', 'midrange');
    await deps.clips.upsert({ userId: A, sessionId: S, shotNumber: 1, shotType: 'midrange', releaseMs: TEMPLATE_CLIP_RELEASE_MS, outcome: 'made', clipPathname: paths.clip(A, S, 1), startMs: 0, endMs: 4000, sizeBytes: 1 });
    // Mirrored into a left-hander: detection should still say left, but with low confidence.
    await deps.clips.setAnalysis(A, S, 1, 'complete', analyze(pro, { mirrored: true }));
    const tools: Record<string, { invoke: (a: object, c: unknown) => Promise<unknown> }> = Object.fromEntries(createCoachTools({ clips: deps.clips, references: deps.references }).map((t) => [t.name, t as never]));
    const run = async (name: string, args: object = {}) => JSON.parse(String(await tools[name]!.invoke(args, { context: { userId: A, sessionId: S } } as never)));

    const m = await run('get_shot_metrics', { shotNumber: 1 });
    assert.deepEqual(m.shootingHand, { value: 'left', source: 'detected', confidence: 'low' });
    assert.equal(m.handNote, HAND_NOTE);
    const cmp = await run('compare_to_reference', { shotNumber: 1 });
    assert.deepEqual([cmp.handUncertain, cmp.handUncertainShots, cmp.shootingHand], [true, [1], 'left']);
    assert.equal(cmp.closestPros[0].player, 'Ray Allen');
    assert.equal((await run('find_similar_pros')).handUncertain, true);

    // The player says they shoot right-handed (wrong for this clip): the analysis is re-derived with that hand.
    await deps.clips.setShootingHand(A, S, 'right');
    const declared = await run('get_shot_metrics', { shotNumber: 1 });
    assert.deepEqual(declared.shootingHand, { value: 'right', source: 'declared', confidence: 'low' });
    assert.equal(declared.handNote, undefined);
    assert.equal((await run('compare_to_reference', { shotNumber: 1 })).handUncertain, undefined);
    // And back to the true hand: the comparison matches Ray Allen again.
    await deps.clips.setShootingHand(A, S, 'left');
    assert.equal((await run('compare_to_reference', { shotNumber: 1 })).closestPros[0].player, 'Ray Allen');
  });
});
