import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { clipTime, shotStats } from '../src/practice.ts';
import { checkImportDuration, recoverRecordings, removeRecording, saveRecording } from '../src/recordings.ts';
import type { RecordingDraft } from '../src/recordings.ts';
import { environment } from './fixture.ts';

function draft(): RecordingDraft {
  return { id: randomUUID(), createdAt: 1794636000000, durationMs: 15300, sizeBytes: 12, sourceUri: 'camera.mov', extension: '.mov' };
}

test('saves a completed clip before recording its session and preserves the extension after relaunch', (t) => {
  const { open, files, path } = environment(t);
  const connection = open();
  const pending = draft();
  writeFileSync(path(pending.sourceUri), Buffer.alloc(pending.sizeBytes));

  const saved = saveRecording(pending, files, connection.store);
  assert.ok(saved.videoPath);
  assert.match(saved.videoPath, /^videos\/.+\.mov$/);
  assert.equal(files.size(saved.videoPath), pending.sizeBytes);
  assert.equal(existsSync(path(pending.sourceUri)), false);
  connection.close();

  const { store } = open();
  assert.deepEqual(store.getSession(pending.id), saved);
  assert.equal(store.listSessions().length, 1);
});

test('recovers a moved clip after a database write failure and app restart', (t) => {
  const { open, files, path } = environment(t);
  const connection = open();
  const pending = draft();
  writeFileSync(path(pending.sourceUri), Buffer.alloc(pending.sizeBytes));

  assert.throws(() => saveRecording(pending, files, {
    getSession: (id) => connection.store.getSession(id),
    saveSession: () => { throw new Error('disk busy'); },
    clearVideo: (id) => connection.store.clearVideo(id),
  }), /disk busy/);
  assert.equal(connection.store.getSession(pending.id), null);
  assert.equal(files.listVideos().length, 1);
  connection.close();

  const { store } = open();
  recoverRecordings(files, store);
  recoverRecordings(files, store);
  assert.equal(store.listSessions().length, 1);
  assert.equal(store.getSession(pending.id)?.durationMs, pending.durationMs);
});

test('retries a completed practice save without moving the clip twice or duplicating its session', (t) => {
  const { open, files, path } = environment(t);
  const { store } = open();
  const pending = draft();
  writeFileSync(path(pending.sourceUri), Buffer.alloc(pending.sizeBytes));
  let interrupted = true;
  const entries = {
    getSession: (id: string) => store.getSession(id),
    saveSession: (session: Parameters<typeof store.saveSession>[0]) => {
      if (interrupted) throw new Error('write not completed');
      store.saveSession(session);
    },
    clearVideo: (id: string) => store.clearVideo(id),
  };
  assert.throws(() => saveRecording(pending, files, entries), /write not completed/);
  interrupted = false;
  const recovered = saveRecording(pending, files, entries);
  assert.deepEqual(saveRecording(pending, files, entries), recovered);
  assert.equal(files.listVideos().length, 1);
  assert.deepEqual(store.listSessions(), [recovered]);
});

test('rejects an incomplete clip and leaves no dangling session', (t) => {
  const { open, files, path } = environment(t);
  const { store } = open();
  const pending = draft();
  writeFileSync(path(pending.sourceUri), Buffer.alloc(pending.sizeBytes - 1));
  assert.throws(() => saveRecording(pending, files, store), /completed recording/);
  assert.deepEqual(store.listSessions(), []);
  assert.deepEqual(files.listVideos(), []);
});

test('stores ordered release timestamps, recomputes after edits, and keeps stats after removing video', (t) => {
  const { open, files, path } = environment(t);
  const connection = open();
  const { store } = connection;
  const pending = draft();
  writeFileSync(path(pending.sourceUri), Buffer.alloc(pending.sizeBytes));
  const session = saveRecording(pending, files, store);
  assert.ok(session.videoPath);

  store.addShot(session.id, 7200, 'made');
  store.addShot(session.id, 1900, 'missed');
  store.addShot(session.id, 9000, 'unmarked');
  assert.deepEqual(store.listShots(session.id).map(({ shotNumber }) => shotNumber), [2, 1, 3]);
  assert.deepEqual(shotStats(store.listShots(session.id)), { makes: 1, attempts: 2, unmarked: 1, percentage: 50 });
  store.updateShot(session.id, 2, 'made');
  assert.equal(shotStats(store.listShots(session.id)).percentage, 100);
  assert.throws(() => store.addShot(session.id, pending.durationMs + 1, 'made'), /inside/);

  removeRecording(session, files, store);
  assert.equal(files.size(session.videoPath), 0);
  connection.close();
  const reopened = open().store;
  assert.equal(reopened.getSession(session.id)?.videoPath, null);
  assert.throws(() => reopened.addShot(session.id, 1100, 'made'), /available clip/);
  assert.deepEqual(reopened.listSessionSummaries()[0]?.stats, { makes: 2, attempts: 2, unmarked: 1, percentage: 100 });
  reopened.updateShot(session.id, 1, 'unmarked');
  assert.deepEqual(reopened.listSessionSummaries()[0]?.stats, { makes: 1, attempts: 1, unmarked: 2, percentage: 100 });
});

test('uses a no-attempts percentage when every tag is unmarked and formats release positions', () => {
  assert.equal(shotStats([]).percentage, null);
  assert.deepEqual(shotStats([{ outcome: 'unmarked' }]), { makes: 0, attempts: 0, unmarked: 1, percentage: null });
  assert.equal(shotStats([{ outcome: 'missed' }]).percentage, 0);
  assert.equal(clipTime(14_987, true), '0:14.9');
  assert.equal(clipTime(0), '0:00');
});

test('attaching a guest clip queues its existing shots for only the active account', (t) => {
  const { open, files, path } = environment(t);
  const { store } = open();
  const pending = draft();
  writeFileSync(path(pending.sourceUri), Buffer.alloc(pending.sizeBytes));
  const clip = saveRecording(pending, files, store);
  store.addShot(clip.id, 2300, 'made');
  store.addShot(clip.id, 4100, 'missed');
  const account = randomUUID();
  const otherAccount = randomUUID();

  assert.equal(store.hasCloudWork(account), false);
  store.prepareAnalysis(clip.id, account, 2);
  store.prepareAnalysis(clip.id, account, 2);
  assert.deepEqual(store.cloudShots(account, 'pending', clip.id), [
    { sessionId: clip.id, shotNumber: 2, releaseMs: 4100, outcome: 'missed' },
  ]);
  store.prepareAnalysis(clip.id, account);
  store.prepareAnalysis(clip.id, account);
  assert.deepEqual(store.cloudShots(account, 'pending', clip.id), [
    { sessionId: clip.id, shotNumber: 1, releaseMs: 2300, outcome: 'made' },
    { sessionId: clip.id, shotNumber: 2, releaseMs: 4100, outcome: 'missed' },
  ]);
  assert.throws(() => store.prepareAnalysis(clip.id, otherAccount), /different account/);
  assert.equal(store.hasCloudWork(otherAccount), false);
});

test('accepts an imported clip that the container rounds just past 30 seconds', () => {
  // Photos trims and Peek's own 30-second recordings often end a frame past 30 s.
  assert.doesNotThrow(() => checkImportDuration(30_000));
  assert.doesNotThrow(() => checkImportDuration(30_034));
  assert.throws(() => checkImportDuration(30_600), /up to 30 seconds/);
  assert.throws(() => checkImportDuration(45_000), /up to 30 seconds/);
});
