import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createResidentLift } from './pose-worker.js';

// Stands in for lift-shot.py --serve: same line protocol, and the "video" path names what to do.
const FAKE_LIFTER = `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [, , flag, coach] = process.argv;
if (flag !== '--serve') process.exit(2);
appendFileSync(coach, 'start\\n');
console.error('library noise on stderr');
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const job = JSON.parse(line);
  if (job.video === 'crash') process.exit(3);
  if (job.video === 'hang') return;
  if (job.video === 'bad') return void process.stdout.write(JSON.stringify({ ok: false, error: 'ValueError: Could not decode the clip' }) + '\\n');
  writeFileSync(job.output, job.video + ':' + job.release_offset_ms + ':' + process.pid);
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
});
`;

test('the resident lifter keeps one process across jobs and replaces it after a crash, a hang or an abort', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'peek-resident-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lifter = join(dir, 'fake-lifter.mjs');
  const starts = join(dir, 'starts.log');
  await writeFile(lifter, FAKE_LIFTER);
  await writeFile(starts, '');
  const resident = createResidentLift({ python: process.execPath, lifter, coachPath: starts, env: process.env, timeoutMs: 1_000 });
  t.after(() => resident.close());
  const out = (name: string) => join(dir, `${name}.npz`);
  const signal = AbortSignal.timeout(10_000);
  const startCount = async () => (await readFile(starts, 'utf8')).split('\n').filter(Boolean).length;

  await resident.ready();
  await resident.lift('a', 3000, out('a'), signal);
  await resident.lift('b', 2500, out('b'), signal);
  const [a, b] = [await readFile(out('a'), 'utf8'), await readFile(out('b'), 'utf8')];
  assert.match(a, /^a:3000:/);
  assert.match(b, /^b:2500:/);
  assert.equal(a.split(':')[2], b.split(':')[2], 'both jobs ran in the same process');
  assert.equal(await startCount(), 1);

  await assert.rejects(resident.lift('bad', 0, out('bad'), signal), /Could not decode the clip/);
  await resident.lift('c', 1, out('c'), signal);
  assert.equal(await startCount(), 1, 'a failed clip keeps the process');

  await assert.rejects(resident.lift('crash', 0, out('x'), signal), /exited/);
  await resident.lift('d', 1, out('d'), signal);
  assert.equal(await startCount(), 2, 'the next job restarts the lifter');

  await assert.rejects(resident.lift('hang', 0, out('x'), signal), (error: Error) => error.name === 'TimeoutError');
  await resident.lift('e', 1, out('e'), signal);
  assert.equal(await startCount(), 3);

  const controller = new AbortController();
  const pending = resident.lift('hang', 0, out('x'), controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending);
  await assert.rejects(resident.lift('f', 1, out('f'), controller.signal), (error: Error) => error.name === 'AbortError');
  await resident.lift('g', 1, out('g'), signal);
  assert.equal(await startCount(), 4);
});
