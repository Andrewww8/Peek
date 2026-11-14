import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { recompute, type ShotAnalysis } from './cv/metrics.js';
import { SHOT, syntheticShot, writeNpz } from './cv/test-pose.js';
import { CLIP_TTL_DAYS, paths } from './deps.js';
import { createLocalDeps, signLocalToken, type LocalDeps } from './local/index.js';

const SECRET = 'analysis-test-secret';
const CV = 'cv-service-token-for-tests';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';

let dir: string;
let deps: LocalDeps;
let app: FastifyInstance;
let tokenA: string;
const npz = writeNpz([{ track: 4, series: syntheticShot() }, { track: 9, series: syntheticShot({ dx: 400, scale: 0.4 }) }]);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perspective-analysis-'));
  await mkdir(join(dir, 'media'));
  await writeFile(join(dir, 'demos.json'), '[]');
  deps = createLocalDeps(join(dir, 'local'), { jwtSecret: SECRET, inMemory: true, cvToken: CV, trimmer: { probeDurationMs: async () => 0, trim: async () => {} } });
  app = await buildApp({ catalogPath: join(dir, 'demos.json'), mediaDir: join(dir, 'media'), deps });
  tokenA = await signLocalToken(SECRET, A);
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) => stat(deps.blob.fileOf(p)).then(() => true, () => false);
/** A synced shot: its row plus its temporary mp4, and the CV worker's npz. */
async function syncedShot(userId = A, shotNumber = 1, withNpz = true) {
  const sessionId = randomUUID();
  const startMs = 1000;
  const releaseMs = startMs + Math.round((SHOT.release * 1000) / SHOT.fps);
  await deps.clips.upsert({ userId, sessionId, shotNumber, shotType: 'three_point', releaseMs, outcome: 'made', clipPathname: paths.clip(userId, sessionId, shotNumber), startMs, endMs: startMs + 4000, sizeBytes: 1000 });
  await deps.blob.put(paths.clip(userId, sessionId, shotNumber), Buffer.alloc(1000, 1), 'video/mp4');
  if (withNpz) await deps.blob.put(paths.analysis(userId, sessionId, shotNumber), Buffer.from(npz), 'application/octet-stream');
  return { userId, sessionId, shotNumber, npzPathname: paths.analysis(userId, sessionId, shotNumber) };
}
const post = (body: unknown, token: string | null = CV) =>
  app.inject({ method: 'POST', url: '/v1/internal/analysis', headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body as object });

describe('POST /v1/internal/analysis', () => {
  test('stores metrics + compact pose in one update, then deletes the npz and the mp4', async () => {
    const shot = await syncedShot();
    const res = await post(shot);
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().status, 'complete');
    assert.equal(res.json().alreadyAnalyzed, false);
    const row = (await deps.clips.get(A, shot.sessionId, 1))!;
    assert.equal(row.analysisStatus, 'complete');
    const a = row.analysis as ShotAnalysis;
    assert.equal(a.version, 2);
    assert.ok(a.comparison, 'the pro-comparable view is stored');
    assert.deepEqual(recompute(a).comparison, a.comparison, 'and recomputes identically');
    assert.equal(a.shooterTrack, 4);
    assert.ok(Math.abs(a.metrics.elbowAngleReleaseDeg! - SHOT.elbowRelease) < 0.5);
    const size = Buffer.byteLength(JSON.stringify(a));
    assert.ok(size < 64 * 1024, `analysis ${size} bytes`);
    assert.deepEqual(recompute(a).metrics, a.metrics, 'metrics recomputed from the stored pose match');
    assert.equal(await exists(shot.npzPathname), false, 'npz deleted');
    assert.equal(await exists(paths.clip(A, shot.sessionId, 1)), false, 'mp4 deleted');
    assert.equal(row.clipPathname, null);
    assert.ok(row.mediaDeletedAt);
  });

  test('a declared shooting hand on the row is used by the analysis', async () => {
    const shot = await syncedShot();
    await deps.clips.setShootingHand(A, shot.sessionId, 'left');
    assert.equal((await post(shot)).json().status, 'complete');
    const a = (await deps.clips.get(A, shot.sessionId, 1))!.analysis as ShotAnalysis;
    assert.deepEqual([a.hand.value, a.hand.source, a.hand.detected], ['left', 'declared', 'right']);
  });

  test('GET /v1/clips returns url null and the metrics for analyzed shots, a URL for pending ones', async () => {
    const done = await syncedShot(A, 1);
    await post(done);
    await deps.clips.upsert({ userId: A, sessionId: done.sessionId, shotNumber: 2, shotType: 'three_point', releaseMs: 4000, outcome: 'missed', clipPathname: paths.clip(A, done.sessionId, 2), startMs: 1000, endMs: 5000, sizeBytes: 10 });
    const res = await app.inject({ url: `/v1/clips?sessionId=${done.sessionId}`, headers: { authorization: `Bearer ${tokenA}` } });
    const [one, two] = res.json().clips;
    assert.deepEqual([one.shotNumber, one.analysisStatus, one.url, one.urlExpiresAt], [1, 'complete', null, null]);
    assert.ok(one.metrics.elbowAngleReleaseDeg > 160);
    assert.equal(one.quality.usable, true);
    assert.equal('pose' in one, false, 'the compact pose stays server-side');
    assert.deepEqual([two.analysisStatus, typeof two.url, two.metrics], ['pending', 'string', null]);
  });

  test('a clip whose 7-day TTL passed unanalyzed is reported as expired, with no URL', async () => {
    const sessionId = randomUUID();
    await deps.clips.upsert({ userId: A, sessionId, shotNumber: 1, shotType: 'three_point', releaseMs: 4000, outcome: 'made', clipPathname: paths.clip(A, sessionId, 1), startMs: 1000, endMs: 5000, sizeBytes: 10 });
    const old = new Date(Date.now() - (CLIP_TTL_DAYS + 1) * 86_400_000).toISOString();
    // Pretend the row was created 8 days ago.
    const orig = deps.clips.list.bind(deps.clips);
    deps.clips.list = async (u, s) => (await orig(u, s)).map((r) => (r.sessionId === sessionId ? { ...r, createdAt: old } : r));
    try {
      const res = await app.inject({ url: `/v1/clips?sessionId=${sessionId}`, headers: { authorization: `Bearer ${tokenA}` } });
      assert.deepEqual([res.json().clips[0].analysisStatus, res.json().clips[0].url], ['expired', null]);
      assert.equal((await deps.clips.get(A, sessionId, 1))!.analysisStatus, 'expired', 'persisted');
    } finally {
      deps.clips.list = orig;
    }
  });

  test('clip uploads carry the 7-day TTL', async () => {
    const calls: unknown[] = [];
    const put = deps.blob.put;
    deps.blob.put = async (p, b, ct, o) => {
      calls.push([p, o]);
      return put(p, b, ct, o);
    };
    try {
      // Exercise the real clip-cut route with a stubbed trimmer.
      const sessionId = randomUUID();
      const up = await app.inject({ method: 'POST', url: '/v1/recordings', headers: { authorization: `Bearer ${tokenA}` }, payload: { sessionId, ext: 'mp4', contentType: 'video/mp4', sizeBytes: 10, durationMs: 5000 } });
      await deps.blob.put(`recordings/${A}/${sessionId}/${up.json().uploadId}.mp4`, Buffer.alloc(10), 'video/mp4');
      deps.trimmer.probeDurationMs = async () => 5000;
      deps.trimmer.trim = async (_i, _s, _e, out) => writeFile(out, Buffer.alloc(50));
      const cut = await app.inject({ method: 'POST', url: `/v1/recordings/${up.json().uploadId}/clips`, headers: { authorization: `Bearer ${tokenA}` }, payload: { sessionId, shotType: 'three_point', shots: [{ shotNumber: 1, releaseMs: 3000, outcome: 'made' }] } });
      assert.equal(cut.statusCode, 200, cut.payload);
      assert.deepEqual(calls.find((c) => (c as string[])[0] === paths.clip(A, sessionId, 1)), [paths.clip(A, sessionId, 1), { ttlDays: CLIP_TTL_DAYS }]);
    } finally {
      deps.blob.put = put;
    }
  });

  test('a crash before the update keeps the inputs for a retry', async () => {
    const shot = await syncedShot();
    const setAnalysis = deps.clips.setAnalysis;
    deps.clips.setAnalysis = async () => {
      throw new Error('killed before the update');
    };
    try {
      assert.equal((await post(shot)).statusCode, 500);
    } finally {
      deps.clips.setAnalysis = setAnalysis;
    }
    assert.equal((await deps.clips.get(A, shot.sessionId, 1))!.analysisStatus, 'pending');
    assert.equal(await exists(shot.npzPathname), true);
    assert.equal(await exists(paths.clip(A, shot.sessionId, 1)), true);
    const retry = await post(shot);
    assert.equal(retry.json().status, 'complete');
    assert.equal(await exists(shot.npzPathname), false);
  });

  test('a crash after the update leaves only files the TTL removes; a retry finishes the cleanup without re-analyzing', async () => {
    const shot = await syncedShot();
    const del = deps.blob.delete;
    deps.blob.delete = async () => {
      throw new Error('killed after the update');
    };
    try {
      assert.equal((await post(shot)).statusCode, 500);
    } finally {
      deps.blob.delete = del;
    }
    const row = (await deps.clips.get(A, shot.sessionId, 1))!;
    assert.equal(row.analysisStatus, 'complete', 'the analysis was saved');
    assert.equal(row.mediaDeletedAt, null);
    assert.equal(await exists(shot.npzPathname), true, 'left for the TTL');
    const retry = await post(shot);
    assert.deepEqual([retry.statusCode, retry.json().status, retry.json().alreadyAnalyzed], [200, 'complete', true]);
    assert.equal(await exists(shot.npzPathname), false);
    assert.equal(await exists(paths.clip(A, shot.sessionId, 1)), false);
    assert.deepEqual((await deps.clips.get(A, shot.sessionId, 1))!.analysis, row.analysis, 'not re-analyzed');
  });

  test('a malformed npz is recorded as failed with a reason, and the media is still deleted', async () => {
    const shot = await syncedShot(A, 1, false);
    await deps.blob.put(shot.npzPathname, Buffer.from('not a zip'), 'application/octet-stream');
    const res = await post(shot);
    assert.deepEqual([res.statusCode, res.json().status, res.json().error.code], [200, 'failed', 'invalid_npz']);
    const row = (await deps.clips.get(A, shot.sessionId, 1))!;
    assert.equal(row.analysisStatus, 'failed');
    assert.equal(await exists(shot.npzPathname), false);
  });

  test('an npz where nobody is near the release fails as shooter_not_found', async () => {
    const shot = await syncedShot(A, 1, false);
    await deps.blob.put(shot.npzPathname, Buffer.from(writeNpz([{ track: 1, series: syntheticShot({ frames: 30 }) }])), 'application/octet-stream');
    assert.equal((await post(shot)).json().error.code, 'shooter_not_found');
  });

  test('auth: only the CV service token, never a user token', async () => {
    const shot = await syncedShot();
    for (const token of [null, 'wrong', tokenA, `${CV}x`]) {
      const res = await post(shot, token);
      assert.deepEqual([res.statusCode, res.json().error], [401, 'unauthorized'], String(token));
    }
    const bare = await buildApp({ catalogPath: join(dir, 'demos.json'), mediaDir: join(dir, 'media'), deps: { ...deps, cvToken: undefined } });
    const res = await bare.inject({ method: 'POST', url: '/v1/internal/analysis', headers: { authorization: `Bearer ${CV}` }, payload: shot });
    assert.deepEqual([res.statusCode, res.json().error], [503, 'not_configured']);
    await bare.close();
  });

  test('the npz must be the shot\'s own path; bad ids, a missing row or a missing npz are precise errors', async () => {
    const shot = await syncedShot();
    const other = await syncedShot(B);
    const cases: [unknown, number, string][] = [
      [{ ...shot, npzPathname: other.npzPathname }, 400, 'invalid_request'],
      [{ ...shot, npzPathname: `analysis/${A}/${shot.sessionId}/../x.npz` }, 400, 'invalid_request'],
      [{ ...shot, userId: 'nope' }, 400, 'invalid_request'],
      [{ ...shot, shotNumber: 0 }, 400, 'invalid_request'],
      [{ ...shot, shotNumber: 7, npzPathname: paths.analysis(A, shot.sessionId, 7) }, 404, 'clip_not_found'],
    ];
    for (const [body, status, error] of cases) {
      const res = await post(body);
      assert.deepEqual([res.statusCode, res.json().error], [status, error], JSON.stringify(body));
    }
    const noNpz = await syncedShot(A, 1, false);
    assert.deepEqual([(await post(noNpz)).statusCode, (await post(noNpz)).json().error], [404, 'npz_not_found']);
    assert.equal(await exists(other.npzPathname), true, "B's npz untouched");
  });

  test('deleting a session also deletes any npz still waiting', async () => {
    const shot = await syncedShot(A, 1);
    const res = await app.inject({ method: 'DELETE', url: `/v1/sessions/${shot.sessionId}`, headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(res.statusCode, 204);
    assert.equal(await exists(shot.npzPathname), false);
  });
});
