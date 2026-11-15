import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readTemplate } from '../src/cv/templates.js';
import { releasePoseView } from '../src/cv/pose-view.js';
import { canonicalize, canonicalQuantized, computeReleaseMetrics, GRID_N, PLAYBACK_FRAME_COUNT } from '../src/cv/release.js';

const source = new URL('../reference-data/average-shots/', import.meta.url);
const output = new URL('../../frontend/assets/peek-nba-poses.json', import.meta.url);
const fullReference = JSON.parse(await readFile(new URL('../../shot_coach/nba_reference.json', import.meta.url), 'utf8')) as {
  averages: Record<string, { three: { pose: number[][][]; ext: number[][][]; rise: number[]; shots: number; hand: 'L' | 'R' } }>;
};
const names = (await readdir(source)).filter((name) => name.endsWith('_three.npz')).sort();
if (!names.length) throw new Error('No three-point reference poses found.');

const players = await Promise.all(names.map(async (name) => {
  const record = readTemplate(await readFile(new URL(name, source)));
  const full = fullReference.averages[record.player]?.three;
  if (!full || full.shots !== record.shotsAveraged || full.hand !== (record.hand === 'right' ? 'R' : 'L')) {
    throw new Error(`${name}: extended reference does not match the supplied template.`);
  }
  // Shot Coach stores the original 30 fps average starting one second before release.
  // Append only the measured frames after our metrics template ends.
  const start = record.fps - record.releaseIndex + GRID_N;
  const end = start + PLAYBACK_FRAME_COUNT - GRID_N;
  const append = (base: Float32Array, later: number[]) => Float32Array.from([...base, ...later.map((v) => v ?? NaN)]);
  const base = canonicalQuantized(record.series);
  const extended = canonicalize({
    ...record.series,
    pose: append(record.series.pose, full.pose.slice(start, end).flat(2)),
    extremities: append(record.series.extremities!, full.ext.slice(start, end).flat(2)),
    pelvisRise: append(record.series.pelvisRise!, full.rise.slice(start, end)),
    spread: null,
  }, GRID_N);
  if (!base || !extended) throw new Error(`${name}: no usable 3D pose near release.`);
  return {
    player: record.player,
    shotsAveraged: record.shotsAveraged,
    pose: releasePoseView(extended, computeReleaseMetrics(base.series)),
  };
}));
await writeFile(output, JSON.stringify(players) + '\n');
console.log('Exported ' + String(players.length) + ' NBA reference poses to ' + fileURLToPath(output));
