import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { GuestQuotaError, syncCloudClips } from '../src/clip-sync.ts';
import type { RecordingUploader } from '../src/clip-sync.ts';
import { SHOT_TYPE } from '../src/practice.ts';
import type { Session } from '../src/practice.ts';
import { environment } from './fixture.ts';

const baseUrl = 'https://perspective.example.test';
const uploadUrl = 'https://vercel-blob.example.test/recording?signature=fixture';
const uploadId = randomUUID();
const user = randomUUID();
const anotherUser = randomUUID();
const headers = { 'x-content-type': 'video/quicktime', 'x-vercel-blob-access': 'private' };

const newSession = (): Session => ({
  id: randomUUID(),
  videoPath: 'videos/clip.mov',
  createdAt: 1,
  durationMs: 19_000,
  sizeBytes: 10_000_000,
  shotType: SHOT_TYPE,
});

const getGrant = () => Response.json({ method: 'PUT', uploadId, uploadUrl, headers });

test('migrates existing sessions and shot stats without queueing their recordings', (t) => {
  const session = newSession();
  const { open } = environment(t);
  const { store, close } = open((db) => {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, shot_type TEXT, video_path TEXT, duration_ms INTEGER, size_bytes INTEGER);
      CREATE TABLE shots (session_id TEXT, shot_number INTEGER, release_ms INTEGER, outcome TEXT, PRIMARY KEY (session_id, shot_number));
      PRAGMA user_version = 1;
    `);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
      session.id, session.createdAt, session.shotType, session.videoPath, session.durationMs, session.sizeBytes,
    );
    db.prepare("INSERT INTO shots VALUES (?, 1, 5000, 'made')").run(session.id);
  });

  assert.deepEqual(store.getSession(session.id), session);
  assert.equal(store.listShots(session.id)[0]?.outcome, 'made');
  store.addShot(session.id, 6_000, 'missed', user);
  assert.equal(store.hasCloudWork(user), false);
  assert.equal(store.getShootingHand(session.id), null);
  store.setShootingHand(session.id, 'left');
  close();
  const reopened = open().store;
  assert.equal(reopened.getShootingHand(session.id), 'left');
  reopened.clearVideo(session.id);
  reopened.setShootingHand(session.id, 'right');
  assert.equal(reopened.getShootingHand(session.id), 'right');
  assert.equal(reopened.getSession(session.id)?.videoPath, null);
  assert.equal(reopened.listShots(session.id).length, 2);
});

test('upgrades the existing cloud queue without assigning a cause to old failures', (t) => {
  const session = newSession();
  const { store } = environment(t).open((db) => {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, shot_type TEXT, video_path TEXT,
        duration_ms INTEGER, size_bytes INTEGER, cloud_user_id TEXT);
      CREATE TABLE shots (session_id TEXT, shot_number INTEGER, release_ms INTEGER, outcome TEXT,
        cloud_state TEXT, cloud_outcome TEXT, PRIMARY KEY (session_id, shot_number));
      CREATE INDEX shots_cloud_state ON shots (cloud_state, session_id) WHERE cloud_state IS NOT NULL;
      PRAGMA user_version = 2;
    `);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      session.id, session.createdAt, session.shotType, session.videoPath, session.durationMs, session.sizeBytes, user,
    );
    db.prepare("INSERT INTO shots VALUES (?, 1, 5000, 'made', 'unavailable', 'made')").run(session.id);
    db.prepare("INSERT INTO shots VALUES (?, 2, 6000, 'missed', 'pending', 'missed')").run(session.id);
  });

  store.prepareAnalysis(session.id, user);
  assert.deepEqual(store.sessionCloudShots(user, session.id), [
    { shotNumber: 1, state: 'unavailable' },
    { shotNumber: 2, state: 'pending' },
  ]);
  assert.deepEqual(store.sessionCloudShots(anotherUser, session.id), []);
  assert.deepEqual(store.listShots(session.id).map(({ outcome }) => outcome), ['made', 'missed']);
});

test('refreshes a rejected Supabase token, uploads directly using the grant, and patches a racing outcome edit', async (t) => {
  const { store } = environment(t).open();
  const session = newSession();
  store.saveSession(session, user);
  store.addShot(session.id, 5_000, 'made', user);
  const calls: string[] = [];
  const authCalls: boolean[] = [];

  const fetchApi: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, baseUrl);
    assert.equal(options?.redirect, 'error');
    const token = new Headers(options?.headers).get('Authorization');
    const body = JSON.parse(String(options?.body));
    calls.push(`${options?.method} ${url.pathname}`);
    if (token === 'Bearer stale') return new Response(null, { status: 401 });
    assert.equal(token, 'Bearer renewed');

    if (url.pathname === '/v1/recordings') {
      assert.deepEqual(body, { sessionId: session.id, ext: 'mov', contentType: 'video/quicktime', sizeBytes: 10_000_000, durationMs: 19_000 });
      return getGrant();
    }
    if (url.pathname === `/v1/recordings/${uploadId}/clips`) {
      assert.deepEqual(body, { sessionId: session.id, shotType: 'three_point', shots: [{ shotNumber: 1, releaseMs: 5000, outcome: 'made' }] });
      store.updateShot(session.id, 1, 'missed', user);
      return Response.json({ clips: [{ shotNumber: 1, startMs: 2000, endMs: 6000, sizeBytes: 50 }] });
    }
    assert.equal(url.pathname, `/v1/sessions/${session.id}/shots/1`);
    assert.deepEqual(body, { outcome: 'missed' });
    return new Response(null, { status: 204 });
  };

  await syncCloudClips({
    baseUrl, store,
    account: { id: user, accessToken: async (refresh) => { authCalls.push(refresh); return refresh ? 'renewed' : 'stale'; } },
    upload: async (destination, path, uploadHeaders) => {
      assert.equal(destination, uploadUrl);
      assert.equal(path, session.videoPath);
      assert.deepEqual({ ...uploadHeaders }, headers);
      calls.push('PUT Blob');
      return 200;
    },
    hasRecording: () => true, signal: new AbortController().signal, fetchApi,
  });

  assert.deepEqual(authCalls, [false, true]);
  assert.deepEqual(calls, [
    'POST /v1/recordings', 'POST /v1/recordings', 'PUT Blob',
    `POST /v1/recordings/${uploadId}/clips`, `PATCH /v1/sessions/${session.id}/shots/1`,
  ]);
  assert.equal(store.hasCloudWork(user), false);
  assert.equal(store.listShots(session.id)[0]?.outcome, 'missed');
});

test('keeps offline work through restart and never queues guest recordings or another account’s tags', async (t) => {
  const { open } = environment(t);
  const connection = open();
  const session = newSession();
  const guest = newSession();
  connection.store.saveSession(session, user);
  connection.store.saveSession(guest);
  connection.store.addShot(guest.id, 1000, 'missed', user);
  connection.store.addShot(session.id, 1000, 'made', anotherUser);
  connection.store.addShot(session.id, 2000, 'made');
  connection.store.addShot(session.id, 5000, 'missed', user);
  connection.store.updateShot(session.id, 3, 'unmarked', anotherUser);
  connection.close();

  const { store } = open();
  const offline: typeof fetch = async () => { throw new Error('offline'); };
  const options = {
    baseUrl, store, upload: (async () => { throw new Error('unexpected upload'); }) satisfies RecordingUploader,
    hasRecording: () => true, signal: new AbortController().signal, fetchApi: offline,
  };
  await syncCloudClips({ ...options, account: { id: anotherUser, accessToken: async () => assert.fail('requested wrong account token') } });
  await assert.rejects(syncCloudClips({ ...options, account: { id: user, accessToken: async () => 'valid' } }), /offline/);
  assert.deepEqual(store.cloudShots(user, 'pending'), [{ sessionId: session.id, shotNumber: 3, releaseMs: 5000, outcome: 'missed' }]);
  assert.equal(store.listShots(session.id)[2]?.outcome, 'unmarked');
  assert.equal(store.hasCloudWork(anotherUser), false);
});

test('a failed cut stays queued while a later recording and a synced shot edit finish', async (t) => {
  const { store } = environment(t).open();
  const first = newSession();
  const next = { ...newSession(), createdAt: 2 };
  const edited = { ...newSession(), createdAt: 3 };
  for (const session of [first, next, edited]) {
    store.saveSession(session, user);
    store.addShot(session.id, 5_000, 'made', user);
  }
  const originalShot = store.cloudShots(user, 'pending', edited.id)[0]!;
  store.finishCloudShot(user, originalShot, 'pending', 'saved');
  store.updateShot(edited.id, 1, 'missed', user);

  let failFirstCut = true;
  const patches: string[] = [];
  const fetchApi: typeof fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(options?.body));
    if (path === '/v1/recordings') return getGrant();
    if (path === `/v1/recordings/${uploadId}/clips`) {
      if (body.sessionId === first.id && failFirstCut) return new Response(null, { status: 500 });
      return Response.json({ clips: [{ shotNumber: 1, startMs: 2000, endMs: 6000, sizeBytes: 50 }] });
    }
    assert.equal(path, `/v1/sessions/${edited.id}/shots/1`);
    patches.push(body.outcome);
    return new Response(null, { status: 204 });
  };
  const sync = () => syncCloudClips({
    baseUrl, store, account: { id: user, accessToken: async () => 'valid' },
    upload: async () => 200, hasRecording: () => true, signal: new AbortController().signal, fetchApi,
  });

  await assert.rejects(sync(), /HTTP 500/);
  assert.deepEqual(store.pendingCloudSessions(user).map(({ id }) => id), [first.id]);
  assert.deepEqual(store.sessionCloudShots(user, first.id), [{ shotNumber: 1, state: 'pending' }]);
  assert.deepEqual(patches, ['missed']);
  assert.deepEqual(store.cloudShots(user, 'dirty'), []);

  failFirstCut = false;
  await sync();
  assert.equal(store.hasCloudWork(user), false);
  assert.deepEqual(store.sessionCloudShots(user, first.id), [{ shotNumber: 1, state: 'synced' }]);
  assert.deepEqual(patches, ['missed']);
});

test('aborted or insecure uploads leave the queue untouched and deleting a local video retains tagged stats', async (t) => {
  const { store } = environment(t).open();
  const session = newSession();
  store.saveSession(session, user);
  store.addShot(session.id, 5000, 'made', user);
  const controller = new AbortController();
  const options = {
    baseUrl, store, account: { id: user, accessToken: async () => 'valid' },
    upload: (async () => assert.fail('unexpected upload')) satisfies RecordingUploader,
    hasRecording: () => true, signal: controller.signal,
  };
  await assert.rejects(syncCloudClips({ ...options, fetchApi: async () => Response.json({
    method: 'PUT', uploadId, uploadUrl: 'http://insecure.example.test/file', headers,
  }) }), /insecure upload URL/);
  assert.equal(store.hasCloudWork(user), true);
  await syncCloudClips({ ...options, fetchApi: async () => { controller.abort(); return getGrant(); } });
  assert.equal(store.hasCloudWork(user), true);

  store.clearVideo(session.id);
  await syncCloudClips({ ...options, signal: new AbortController().signal, fetchApi: async () => assert.fail('unexpected request') });
  assert.equal(store.hasCloudWork(user), false);
  assert.equal(store.listShots(session.id)[0]?.outcome, 'made');
  assert.equal(store.getSession(session.id)?.videoPath, null);
  assert.deepEqual(store.sessionCloudShots(user, session.id), [{ shotNumber: 1, state: 'unavailable', issue: 'missing_recording' }]);
});

test('keeps distinguishable local and API rejection causes after reopening the database', async (t) => {
  const { open } = environment(t);
  const connection = open();
  const { store } = connection;
  const unsupported = { ...newSession(), videoPath: 'videos/clip.avi' };
  const rejected = [
    { session: newSession(), status: 400, code: 'invalid_request', issue: 'invalid_shot' },
    { session: newSession(), status: 413, code: 'recording_too_large', issue: 'recording_too_large' },
    { session: newSession(), status: 415, code: 'unsupported_media_type', issue: 'unsupported_recording' },
    { session: newSession(), status: 422, code: 'recording_too_long', issue: 'recording_too_long' },
    { session: newSession(), status: 422, code: 'recording_unreadable', issue: 'recording_unreadable' },
    { session: newSession(), status: 422, code: 'unrecognized_error' },
  ];
  for (const session of [unsupported, ...rejected.map(({ session }) => session)]) {
    store.saveSession(session, user);
    store.addShot(session.id, 5000, 'unmarked', user);
  }

  await syncCloudClips({
    baseUrl, store, account: { id: user, accessToken: async () => 'valid' },
    upload: async () => assert.fail('unexpected upload'), hasRecording: () => true, signal: new AbortController().signal,
    fetchApi: async (_input, options) => {
      const { sessionId } = JSON.parse(String(options?.body));
      const failure = rejected.find(({ session }) => session.id === sessionId);
      assert.ok(failure);
      return Response.json({ error: failure.code, message: 'Diagnostic from the API' }, { status: failure.status });
    },
  });
  connection.close();

  const { store: reopened } = open();
  assert.deepEqual(reopened.sessionCloudShots(user, unsupported.id), [
    { shotNumber: 1, state: 'unavailable', issue: 'unsupported_recording' },
  ]);
  for (const { session, issue } of rejected) {
    assert.deepEqual(reopened.sessionCloudShots(user, session.id), [
      { shotNumber: 1, state: 'unavailable', ...(issue ? { issue } : {}) },
    ]);
  }
  assert.equal(reopened.hasCloudWork(user), false);
});

test('a rejected release and a missing cloud clip get specific causes while quota work remains pending', async (t) => {
  const { store } = environment(t).open();
  const session = newSession();
  store.saveSession(session, user);
  for (const release of [5000, 6000, 7000]) store.addShot(session.id, release, 'made', user);
  const sync = (fetchApi: typeof fetch) => syncCloudClips({
    baseUrl, store, account: { id: user, accessToken: async () => 'valid' },
    upload: async () => 200, hasRecording: () => true, signal: new AbortController().signal, fetchApi,
  });

  await assert.rejects(sync(async (input) => {
    if (new URL(String(input)).pathname === '/v1/recordings') return getGrant();
    return Response.json({ clips: [
      { shotNumber: 1, startMs: 1000, endMs: 6000, sizeBytes: 50 },
      { shotNumber: 2, error: 'release_beyond_duration' },
      { shotNumber: 3, error: 'guest_daily_limit', message: 'Guest limit reached.' },
    ] });
  }), GuestQuotaError);
  assert.deepEqual(store.sessionCloudShots(user, session.id), [
    { shotNumber: 1, state: 'synced' },
    { shotNumber: 2, state: 'unavailable', issue: 'release_after_end' },
    { shotNumber: 3, state: 'pending' },
  ]);

  store.updateShot(session.id, 1, 'missed', user);
  await sync(async (input, options) => {
    if (options?.method === 'PATCH') return Response.json({ error: 'clip_not_found' }, { status: 404 });
    if (new URL(String(input)).pathname === '/v1/recordings') return getGrant();
    return Response.json({ clips: [{ shotNumber: 3, startMs: 1000, endMs: 8000, sizeBytes: 50 }] });
  });
  assert.deepEqual(store.sessionCloudShots(user, session.id), [
    { shotNumber: 1, state: 'unavailable', issue: 'cloud_clip_missing' },
    { shotNumber: 2, state: 'unavailable', issue: 'release_after_end' },
    { shotNumber: 3, state: 'synced' },
  ]);
});
