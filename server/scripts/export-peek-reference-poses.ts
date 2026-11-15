import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildTemplateRecord } from '../src/cv/templates.js';
import { poseView } from '../src/cv/pose-view.js';

const source = new URL('../reference-data/average-shots/', import.meta.url);
const output = new URL('../../frontend/assets/peek-nba-poses.json', import.meta.url);
const names = (await readdir(source)).filter((name) => name.endsWith('_three.npz')).sort();
if (!names.length) throw new Error('No three-point reference poses found.');

const players = await Promise.all(names.map(async (name) => {
  const record = buildTemplateRecord(await readFile(new URL(name, source)), name);
  return {
    player: record.player,
    shotsAveraged: record.shotsAveraged,
    pose: poseView(record.template, record.metrics),
  };
}));
await writeFile(output, JSON.stringify(players) + '\n');
console.log('Exported ' + String(players.length) + ' NBA reference poses to ' + fileURLToPath(output));
