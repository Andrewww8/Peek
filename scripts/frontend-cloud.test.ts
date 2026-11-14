import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { syncCloudClips } from '../frontend/src/clip-sync.ts';
import { PracticeStore } from '../frontend/src/database.ts';
import { buildApp } from '../server/src/app.js';
import { createLocalDeps, signLocalToken } from '../server/src/local/index.js';
import { makeVideo } from '../server/src/test-video.js';

test('the iPhone queue uploads a recording, cuts private clips and syncs a later edit', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'perspective-frontend-cloud-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const db = new DatabaseSync(join(temp, 'practice.sqlite'));
  t.after(() => db.close());
  const store = new PracticeStore({
    execSync: (sql) => db.exec(sql),
    runSync: (sql, ...params) => db.prepare(sql).run(...params),
    getAllSync: <T>(sql: string, ...params: (string | number | null)[]) => db.prepare(sql).all(...params) as T[],
    getFirstSync: <T>(sql: string, ...params: (string | number | null)[]) =>
      (db.prepare(sql).get(...params) as T | undefined) ?? null,
  });
  const secret = randomUUID();
  const app = await buildApp({
    catalogPath: 'server/catalog/demos.json',
    mediaDir: 'server/media',
    deps: createLocalDeps(temp, { jwtSecret: secret, inMemory: true }),
  });
  t.after(() => app.close());
  const localUrl = await app.listen({ host: '127.0.0.1', port: 0 });

  // Translate the app's HTTPS origin to the loopback fixture's HTTP origin.
  const baseUrl = 'https://perspective.example.test';
  const fetchApi: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, baseUrl);
    const response = await fetch(localUrl + url.pathname + url.search, options);
    if (!response.ok || url.pathname !== '/v1/recordings') return response;
    const grant = await response.json() as { uploadUrl: string };
    assert.equal(new URL(grant.uploadUrl).origin, localUrl);
    return Response.json({ ...grant, uploadUrl: grant.uploadUrl.replace(localUrl, baseUrl) });
  };

  const user = randomUUID();
  const sessionId = randomUUID();
  const token = await signLocalToken(secret, user);
  const expired = await signLocalToken(secret, user, -1);
  const otherUser = await signLocalToken(secret, randomUUID());
  const videoPath = join(temp, 'practice.mov');
  await makeVideo(videoPath, { seconds: 7, fps: 24, audio: false });
  const recording = await readFile(videoPath);
  store.saveSession({
    id: sessionId, createdAt: Date.now(), shotType: 'three_point', videoPath, durationMs: 7000, sizeBytes: recording.length,
  }, user);
  store.addShot(sessionId, 3500, 'made', user);
  store.addShot(sessionId, 5900, 'missed', user);

  let refreshes = 0;
  const run = (accessToken: (refresh: boolean) => Promise<string>) => syncCloudClips({
    baseUrl, store, account: { id: user, accessToken }, fetchApi, signal: AbortSignal.timeout(30_000),
    hasRecording: (path) => path === videoPath,
    upload: async (destination, path, headers, signal) => {
      const url = new URL(destination);
      assert.equal(url.origin, baseUrl);
      assert.equal(path, videoPath);
      assert.equal(new Headers(headers).has('authorization'), false);
      const response = await fetch(localUrl + url.pathname + url.search, {
        method: 'PUT', headers, signal, body: new Uint8Array(recording),
      });
      await response.body?.cancel();
      return response.status;
    },
  });
  await run(async (refresh) => {
    if (refresh) refreshes += 1;
    return refresh ? token : expired;
  });
  assert.equal(refreshes, 1);

  async function list(bearer: string) {
    const response = await fetch(`${localUrl}/v1/clips?sessionId=${sessionId}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    assert.equal(response.status, 200);
    return (await response.json() as { clips: {
      shotNumber: number; startMs: number; endMs: number; outcome: string; url: string;
    }[] }).clips;
  }
  const clips = await list(token);
  assert.deepEqual(clips.map(({ shotNumber, startMs, endMs, outcome }) => [shotNumber, startMs, endMs, outcome]), [
    [1, 500, 4500, 'made'], [2, 2900, 6900, 'missed'],
  ]);
  for (const { url } of clips) {
    const response = await fetch(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
  }
  assert.deepEqual(await list(otherUser), []);
  const leftovers = await readdir(join(temp, 'blobs', 'recordings', user, sessionId)).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  assert.deepEqual(leftovers, []);

  store.updateShot(sessionId, 1, 'unmarked', user);
  await run(async () => token);
  assert.equal((await list(token))[0]?.outcome, 'unmarked');
  assert.equal(store.hasCloudWork(user), false);
});
