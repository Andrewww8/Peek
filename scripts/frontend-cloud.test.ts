import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { GuestQuotaError, syncCloudClips } from '../frontend/src/clip-sync.ts';
import { createSessionCoach } from '../frontend/src/coach.ts';
import { PracticeStore } from '../frontend/src/database.ts';
import { comparisonUsdz, type NameAtlas, type Pose } from '../frontend/src/pose-3d.ts';
import { getShotAnalysis } from '../frontend/src/shot-analysis.ts';
import { processPoseBatch } from '../server/scripts/pose-worker.js';
import { buildApp } from '../server/src/app.js';
import { GUEST_DAILY_LIMIT } from '../server/src/coach/deps.js';
import { J, NE, NJ } from '../server/src/cv/pose.js';
import { SHOT, syntheticShot, writeNpz } from '../server/src/cv/test-pose.js';
import { paths } from '../server/src/deps.js';
import { LOCAL_CV_TOKEN, createLocalDeps, signLocalToken } from '../server/src/local/index.js';
import { makeVideo } from '../server/src/test-video.js';
import { ScriptedChatModel } from '../sim/coachModel.js';

test('a guest syncs private shots, compares their motion, and chats within the daily limit', async (t) => {
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
  const model = new ScriptedChatModel();
  model.script = ({ human, messages }) => ({
    text: human.startsWith('Follow-up') && messages.some((message) => message.text === 'Hold your finish.')
      ? 'Keep your wrist relaxed.' : 'Hold your finish.',
  });
  let today = '2026-11-15';
  const deps = createLocalDeps(temp, {
    jwtSecret: secret, inMemory: true, coachModel: () => model, today: () => today, guestDailyLimit: GUEST_DAILY_LIMIT,
  });
  const app = await buildApp({
    catalogPath: 'server/catalog/demos.json',
    mediaDir: 'server/media',
    deps,
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
  const token = await signLocalToken(secret, user, 3600, true);
  const expired = await signLocalToken(secret, user, -1, true);
  const otherUserId = randomUUID();
  const otherUser = await signLocalToken(secret, otherUserId);
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
  assert.equal(await deps.usage.count(user, today), 2);
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

  const workerUrl = new URL(localUrl);
  const jobs = await fetch(new URL('/v1/internal/analysis/jobs', workerUrl), {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(jobs.status, 401, 'a player JWT cannot read the internal work queue');
  await jobs.body?.cancel();
  assert.deepEqual(store.sessionCloudShots(otherUserId, sessionId), []);
  assert.deepEqual(store.listCoachSessions(user).map(({ id }) => id), [sessionId]);
  assert.deepEqual(store.listCoachSessions(otherUserId), []);

  const analysis = () => getShotAnalysis(baseUrl, sessionId, async () => token, AbortSignal.timeout(5_000), fetchApi);
  const posePath = '/v1/sessions/' + sessionId + '/shots/1/pose';
  const readPose = (bearer: string, full = false) =>
    fetch(localUrl + posePath + (full ? '?followThrough=1' : ''), { headers: { Authorization: 'Bearer ' + bearer } });
  assert.equal((await analysis()).get(1)?.status, 'pending');
  assert.equal((await readPose(token)).status, 409);
  const shotTrack = syntheticShot();
  const secondTrack = syntheticShot();
  for (const [trackIndex, series] of [shotTrack, secondTrack].entries()) {
    series.extremities3d = new Float32Array(series.frames.length * NE * 3).fill(NaN);
    series.frames.forEach((frame, index) => {
      const wrist = (index * NJ + J.r_wrist) * 3;
      if (trackIndex) series.pose3d[wrist + 2]! += Math.sin(frame / 9) * 0.18;
      const [x, y, z] = series.pose3d.subarray(wrist, wrist + 3);
      series.extremities3d!.set([x!, y! - 0.06, z! + 0.01], (index * NE + 1) * 3);
    });
  }
  secondTrack.effectiveFps = secondTrack.fps;
  secondTrack.fps *= 2;
  secondTrack.frames = secondTrack.frames.map((frame) => frame * 2);
  const poseInputs = [shotTrack, secondTrack].map((series) => writeNpz([{ track: 1, series }], {
    fps: series.fps, effectiveFps: series.effectiveFps,
  }));
  let liftedShots = 0;
  const batch = await processPoseBatch(workerUrl, LOCAL_CV_TOKEN, async (video, releaseMs, output) => {
    const bytes = await readFile(video);
    assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
    assert.equal(releaseMs, 3000);
    await writeFile(output, poseInputs[liftedShots++]!);
  }, AbortSignal.timeout(15_000));
  assert.deepEqual(batch, { complete: 2, failed: 0, skipped: 0, retry: 0 });
  const read = await analysis();
  assert.deepEqual([...read.keys()], [1, 2]);
  assert.equal(read.get(1)?.status, 'complete');
  assert.equal(read.get(1)?.usable, true);
  assert.ok(Math.abs(read.get(1)!.elbowAngleDeg! - SHOT.elbowRelease) < 0.5);
  const legacyResponse = await readPose(token);
  assert.equal(legacyResponse.status, 200);
  const { pose: legacyPose } = await legacyResponse.json() as { pose: Pose };
  assert.equal(legacyPose.frameCount, 37, 'older clients still receive the original timeline');
  const playerPoseResponse = await readPose(token, true);
  assert.equal(playerPoseResponse.status, 200);
  assert.equal(playerPoseResponse.headers.get('cache-control'), 'private, no-store');
  const { pose: playerPose } = await playerPoseResponse.json() as { pose: Pose };
  const library = JSON.parse(await readFile('frontend/assets/peek-nba-poses.json', 'utf8')) as {
    player: string; pose: typeof playerPose;
  }[];
  assert.equal(library.length, 10);
  const curry = library.find(({ player }) => player === 'Stephen Curry');
  const lillard = library.find(({ player }) => player === 'Damian Lillard');
  assert.ok(curry && lillard);
  assert.deepEqual([playerPose.fps, playerPose.releaseIndex], [curry.pose.fps, curry.pose.releaseIndex]);
  assert.equal(playerPose.frameCount, playerPose.releaseIndex + playerPose.fps + 1);
  assert.equal(playerPose.joints.length, 55 * 17 * 3);
  assert.ok(curry.pose.frameCount > legacyPose.frameCount, 'the supplied NBA reference includes recorded follow-through');
  const wrist = (frame: number) => playerPose.joints.slice((frame * NJ + J.r_wrist) * 3, (frame * NJ + J.r_wrist + 1) * 3);
  assert.notDeepEqual(wrist(40), wrist(36), 'the extended timeline includes measured motion after the old cutoff');
  assert.ok(playerPose.fingers?.some((value) => value !== null));
  assert.notDeepEqual(playerPose.joints, curry.pose.joints);
  assert.notDeepEqual(curry.pose.joints, lillard.pose.joints);
  assert.equal((await readPose(otherUser)).status, 404);
  const secondPoseResponse = await fetch(localUrl + posePath.replace('/1/pose', '/2/pose') + '?followThrough=1', {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(secondPoseResponse.status, 200, secondPoseResponse.ok ? undefined : await secondPoseResponse.text());
  const { pose: secondPose } = await secondPoseResponse.json() as { pose: Pose };
  assert.notDeepEqual(playerPose.joints, secondPose.joints);
  assert.ok(secondPose.fingers?.some((value) => value !== null));
  const atlas = JSON.parse(await readFile('frontend/assets/peek-ar-name-atlas.json', 'utf8')) as NameAtlas;
  const png = await readFile('frontend/assets/peek-ar-name-atlas.png');
  const labels = { atlas, png, player: 'Player One', reference: curry.player };
  const ar = unzipSync(comparisonUsdz(playerPose, curry.pose, labels));
  const scene = new TextDecoder().decode(ar['PeekComparison.usda']);
  assert.match(scene, /endTimeCode = 216/);
  assert.match(scene, /timeCodesPerSecond = 60/);
  assert.match(scene, /def Xform "Player"[\s\S]+primvars:displayColor = \[\(1\.00000, 1\.00000, 1\.00000\)\]/);
  assert.match(scene, /def Xform "NBAReference"[\s\S]+primvars:displayColor = \[\(1\.00000, 0\.79000, 0\.04000\)\]/);
  assert.match(scene, /xformOp:orient\.timeSamples/);
  assert.match(scene, /def Sphere "Finger_1"/);
  assert.match(scene, /def Mesh "PlayerName"/);
  assert.match(scene, /def Mesh "NBAReferenceName"/);
  assert.deepEqual(Buffer.from(ar['NameAtlas.png']!), png);
  const splitActors = (usda: string) => usda.split('def Scope "NameMaterials"')[0]!.split('def Xform "NBAReference"');
  const secondScene = new TextDecoder().decode(unzipSync(comparisonUsdz(secondPose, curry.pose, labels))['PeekComparison.usda']);
  const switchedReference = comparisonUsdz(playerPose, lillard.pose, { ...labels, reference: lillard.player });
  const switchedScene = new TextDecoder().decode(unzipSync(switchedReference)['PeekComparison.usda']);
  const [white, yellow] = splitActors(scene);
  const [secondWhite, secondYellow] = splitActors(secondScene);
  const [switchedWhite, switchedYellow] = splitActors(switchedScene);
  assert.notEqual(white, secondWhite);
  assert.equal(yellow, secondYellow);
  assert.equal(white, switchedWhite);
  assert.notEqual(yellow, switchedYellow);
  assert.match(switchedScene, /custom string peek:name = "Damian Lillard"/);
  assert.equal((await list(token))[0]?.url, null);
  assert.deepEqual(await list(otherUser), []);
  assert.equal(await deps.blob.head(paths.clip(user, sessionId, 1)), null);
  assert.deepEqual(
    await processPoseBatch(workerUrl, LOCAL_CV_TOKEN, async () => assert.fail('completed clips must leave the queue'), AbortSignal.timeout(5_000)),
    { complete: 0, failed: 0, skipped: 0, retry: 0 },
  );

  const coach = createSessionCoach(baseUrl, sessionId, async () => token, fetchApi);
  const alienCoach = createSessionCoach(baseUrl, sessionId, async () => otherUser, fetchApi);
  const chatSignal = AbortSignal.timeout(15_000);
  assert.deepEqual(await coach.history(chatSignal), []);
  const tokens: string[] = [];
  assert.equal((await coach.ask('How was my follow-through?', chatSignal, () => {}, (piece) => tokens.push(piece))).text, 'Hold your finish.');
  assert.equal(tokens.join(''), 'Hold your finish.');
  assert.equal((await coach.ask('Follow-up: what should I feel?', chatSignal, () => {})).text, 'Keep your wrist relaxed.');
  assert.deepEqual((await coach.history(chatSignal)).map(({ role, text }) => [role, text]), [
    ['user', 'How was my follow-through?'], ['assistant', 'Hold your finish.'],
    ['user', 'Follow-up: what should I feel?'], ['assistant', 'Keep your wrist relaxed.'],
  ]);
  assert.deepEqual(await alienCoach.history(chatSignal), []);
  assert.equal((await alienCoach.ask('Give me a follow-through cue', chatSignal, () => {})).text, 'Hold your finish.');
  assert.deepEqual((await alienCoach.history(chatSignal)).map(({ text }) => text), ['Give me a follow-through cue', 'Hold your finish.']);
  assert.equal((await coach.history(chatSignal)).length, 4, 'general chat under the same UUID belongs to the requesting user');
  await coach.ask('One more exercise?', chatSignal, () => {});
  assert.equal(await deps.usage.count(user, today), GUEST_DAILY_LIMIT);
  await assert.rejects(coach.ask('Can you answer again?', chatSignal, () => {}), /guest limit/);
  store.addShot(sessionId, 6300, 'unmarked', user);
  await assert.rejects(run(async () => token), GuestQuotaError);
  assert.deepEqual(store.cloudShots(user, 'pending', sessionId).map(({ shotNumber }) => shotNumber), [3]);
  assert.equal((await readPose(token)).status, 200, 'guests can still view completed analyses at the limit');
  today = '2026-11-16';
  await run(async () => token);
  assert.equal(await deps.usage.count(user, today), 1);
  assert.equal(store.hasCloudWork(user), false);
});
