import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { SHOT, syntheticShot, writeNpz } from '../src/cv/test-pose.js';
import { paths } from '../src/deps.js';
import { createLocalDeps, LOCAL_CV_TOKEN, type LocalDeps } from '../src/local/index.js';
import { cvAttach } from './cv-attach.js';
import { ingestReference } from './reference-ingest.js';
import { reviewReference } from './reference-review.js';

// The sample CV output sits next to the repository checkout (PROJECT_CONTEXT.md); it is never committed.
const SAMPLE = process.env.PERSPECTIVE_SAMPLE_NPZ || fileURLToPath(new URL('../../../_EuBHf42Zs8.npz', import.meta.url));
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
let dir: string;
let deps: LocalDeps;
let npzFile: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perspective-cv-scripts-'));
  deps = createLocalDeps(join(dir, 'local'), { jwtSecret: 's', inMemory: true });
  npzFile = join(dir, 'clip.npz');
  await writeFile(npzFile, writeNpz([{ track: 2, series: syntheticShot() }]));
});
after(() => rm(dir, { recursive: true, force: true }));

const exists = (p: string) => stat(deps.blob.fileOf(p)).then(() => true, () => false);
async function shot() {
  const sessionId = randomUUID();
  await deps.clips.upsert({ userId: A, sessionId, shotNumber: 1, shotType: 'three_point', releaseMs: Math.round((SHOT.release * 1000) / SHOT.fps), outcome: 'made', clipPathname: paths.clip(A, sessionId, 1), startMs: 0, endMs: 4000, sizeBytes: 1 });
  await deps.blob.put(paths.clip(A, sessionId, 1), Buffer.alloc(1), 'video/mp4');
  return sessionId;
}

describe('cv-attach', () => {
  test('uploads the npz to the analysis path and runs the analysis in-process', async () => {
    const sessionId = await shot();
    const r = await cvAttach(deps, { npzFile, userId: A, sessionId, shotNumber: 1 });
    assert.equal(r.status, 'complete');
    assert.equal((await deps.clips.get(A, sessionId, 1))!.analysisStatus, 'complete');
    assert.equal(await exists(paths.analysis(A, sessionId, 1)), false);
    assert.equal(await exists(paths.clip(A, sessionId, 1)), false);
  });

  test('with --api it calls POST /v1/internal/analysis with the CV token', async () => {
    await mkdir(join(dir, 'media'), { recursive: true });
    await writeFile(join(dir, 'demos.json'), '[]');
    const app = await buildApp({ catalogPath: join(dir, 'demos.json'), mediaDir: join(dir, 'media'), deps });
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      const res = await app.inject({ method: 'POST', url: new URL(url).pathname, headers: init.headers as Record<string, string>, payload: String(init.body) });
      return new Response(res.payload, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const sessionId = await shot();
    const r = await cvAttach(deps, { npzFile, userId: A, sessionId, shotNumber: 1, api: 'http://127.0.0.1:3001/', fetchImpl });
    assert.equal((r as { status: string }).status, 'complete');
    assert.deepEqual(seen, [`http://127.0.0.1:3001/v1/internal/analysis Bearer ${LOCAL_CV_TOKEN}`]);
    await assert.rejects(cvAttach(deps, { npzFile, userId: A, sessionId: randomUUID(), shotNumber: 1, api: 'http://x', fetchImpl }), /analysis failed: 404/);
    await app.close();
  });

  test('rejects bad ids before uploading anything', async () => {
    await assert.rejects(cvAttach(deps, { npzFile, userId: 'me', sessionId: randomUUID(), shotNumber: 1 }), /UUID/);
  });
});

describe('reference library scripts', () => {
  test('ingest proposes unverified candidates; review verifies, rejects, and finalize deletes the source media', async () => {
    const long = join(dir, 'pro.npz');
    await writeFile(long, writeNpz([{ track: 1, series: syntheticShot({ frames: 300 }) }, { track: 5, series: syntheticShot({ frames: 300, dx: 300 }) }]));
    const video = join(dir, 'pro.mp4');
    await writeFile(video, Buffer.alloc(100));
    const r = await ingestReference(deps, { npzFile: long, videoFile: video, title: 'Pro catch-and-shoot', source: 'team footage', rightsNote: 'internal use only' });
    assert.ok(r.candidates.length >= 2, `${r.candidates.length} candidates`);
    assert.equal(await exists(paths.reference(r.clipId, 'source.npz')), true);
    assert.equal(await exists(paths.reference(r.clipId, 'source.mp4')), true);
    const shots = await deps.references.listShots({ clipId: r.clipId });
    assert.ok(shots.every((s) => !s.verified && (s.metrics as { metrics: unknown }).metrics));

    const listing = await reviewReference(deps, { list: true });
    assert.ok(listing.some((l) => l.includes('candidate') && l.includes('Pro catch-and-shoot') && /t=\d+\.\d+s/.test(l)));
    assert.deepEqual(await reviewReference(deps, { verify: [shots[0]!.id] }), ['verified 1 shot(s)']);
    assert.deepEqual(await reviewReference(deps, { reject: [shots[1]!.id] }), ['rejected 1 candidate(s)']);
    const [fin] = await reviewReference(deps, { finalize: r.clipId });
    assert.match(fin!, /deleted source media and \d+ unverified candidate\(s\); 1 verified shot\(s\) kept as data/);
    assert.equal(await exists(paths.reference(r.clipId, 'source.npz')), false);
    assert.equal(await exists(paths.reference(r.clipId, 'source.mp4')), false);
    const kept = await deps.references.listShots({ clipId: r.clipId });
    assert.deepEqual(kept.map((s) => [s.id, s.verified]), [[shots[0]!.id, true]]);
    assert.equal((await deps.references.listClips()).find((c) => c.id === r.clipId)!.npzPathname, null);
    await assert.rejects(reviewReference(deps, { finalize: randomUUID() }), /no reference clip/);
  });

  test('ingest requires the rights metadata', async () => {
    await assert.rejects(ingestReference(deps, { npzFile, title: 't', source: '', rightsNote: 'r' }), /required/);
  });

  test('ingesting the sample broadcast clip', { skip: !existsSync(SAMPLE) && 'sample npz not present' }, async () => {
    const r = await ingestReference(deps, { npzFile: SAMPLE, title: 'Sample broadcast', source: '_EuBHf42Zs8', rightsNote: 'evaluation only' });
    assert.equal(r.candidates.length, 7);
    assert.equal((await deps.references.listShots({ clipId: r.clipId, verified: false })).length, 7);
  });
});
