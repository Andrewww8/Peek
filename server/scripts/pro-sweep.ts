/**
 * Robustness sweep: every pro template is turned into player clips at `count` random poses
 * (yaw ±40°, scale ±5 %, noise), as its own hand and mirrored, and run through the real clip
 * pipeline. Reports how often the shooting hand is detected right and where the source pro ranks.
 *
 *   npm run pro-sweep -w server [-- <count> <seed>]
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rankPros, playerComparable } from '../src/coach/compare.js';
import type { TemplateRow } from '../src/coach/deps.js';
import { PRO_BASELINES } from '../src/coach/pro-baselines.generated.js';
import { analyzeSeries } from '../src/cv/metrics.js';
import { TEMPLATE_CLIP_RELEASE_FRAME, clipFromCompactTemplate, sweepPoses } from '../src/cv/synthetic.js';
import { buildTemplateRecord, type TemplateRecord } from '../src/cv/templates.js';
import type { ClipRow } from '../src/deps.js';

export interface SweepRow {
  source: string;
  mirrored: boolean;
  trials: number;
  handRight: number;
  lowConfidence: number;
  selfFirst: number;
  selfTop2: number;
}

export async function loadRecords(dir = join(import.meta.dirname, '..', 'reference-data', 'average-shots')): Promise<TemplateRecord[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.npz')).sort();
  return Promise.all(files.map(async (f) => buildTemplateRecord(await readFile(join(dir, f)), f)));
}

export function sweep(records: TemplateRecord[], count: number, seed: number, opts: { declaredHand?: boolean } = {}): SweepRow[] {
  const rows: SweepRow[] = [];
  const poses = sweepPoses(count, seed);
  for (const r of records) {
    const templates: TemplateRow[] = records.filter((x) => x.shotType === r.shotType).map((x) => ({ ...x, createdAt: '', updatedAt: '' }));
    for (const mirrored of [false, true]) {
      const hand = mirrored ? (r.shootingHand === 'right' ? 'left' : 'right') : r.shootingHand;
      const row: SweepRow = { source: `${r.player} ${r.shotType}`, mirrored, trials: 0, handRight: 0, lowConfidence: 0, selfFirst: 0, selfTop2: 0 };
      for (const pose of poses) {
        const clip = clipFromCompactTemplate(r.template, { ...pose, mirrored });
        const a = analyzeSeries(clip, 1, { taggedReleaseFrame: TEMPLATE_CLIP_RELEASE_FRAME, windowStart: 0, windowEnd: clip.frames.at(-1)!, cuts: [], declaredHand: opts.declaredHand ? hand : undefined });
        row.trials++;
        if (a.metrics.shootingHand === hand) row.handRight++;
        if (a.hand?.confidence === 'low') row.lowConfidence++;
        const p = playerComparable([{ shotNumber: 1, analysisStatus: 'complete', analysis: a } as unknown as ClipRow]);
        if (!p) continue;
        const ranked = rankPros(p, templates, PRO_BASELINES[r.shotType]!).map((x) => x.player);
        if (ranked[0] === r.player) row.selfFirst++;
        if (ranked.slice(0, 2).includes(r.player)) row.selfTop2++;
      }
      rows.push(row);
    }
  }
  return rows;
}

export function formatSweep(rows: SweepRow[]): string {
  return rows
    .map((r) => `${(r.source + (r.mirrored ? ' (mirrored)' : '')).padEnd(46)} hand ${String(r.handRight).padStart(2)}/${r.trials}  low-conf ${String(r.lowConfidence).padStart(2)}  self #1 ${String(r.selfFirst).padStart(2)}  top-2 ${String(r.selfTop2).padStart(2)}`)
    .join('\n');
}

if (import.meta.filename === process.argv[1]) {
  const [count = '40', seed = '20261114'] = process.argv.slice(2);
  const rows = sweep(await loadRecords(), Number(count), Number(seed));
  console.log(formatSweep(rows));
}
