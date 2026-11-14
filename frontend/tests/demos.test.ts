import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { cachedDemo, downloadDemo, fetchDemoCatalog } from '../src/demos.ts';
import type { CatalogDemo } from '../src/demos.ts';
import { SHOT_TYPE } from '../src/practice.ts';
import { environment } from './fixture.ts';

const modelPath = '/media/three-point-follow-through.usdz';
const body = Buffer.from('network-fixture');
const entry = {
  id: 'three-point-follow-through',
  version: 1,
  shotType: SHOT_TYPE,
  cue: 'Hold your finish until the ball reaches the rim.',
  assets: [{ format: 'usdz', url: modelPath, sizeBytes: body.length }],
};
const cloudOrigin = 'https://perspective.example.test';

async function server(t: TestContext, handle: RequestListener) {
  const fixture = createServer(handle);
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  let open = true;
  const close = () => new Promise<void>((resolve) => {
    if (!open) { resolve(); return; }
    open = false;
    fixture.close(() => resolve());
  });
  t.after(close);
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Could not start test HTTP server');
  return { url: `http://127.0.0.1:${address.port}`, close };
}

function modelAt(url: string, version = 1): CatalogDemo {
  return { id: entry.id, version, shotType: SHOT_TYPE, cue: entry.cue, url: `${url}${modelPath}`, sizeBytes: body.length };
}

test('queries the correct drill and resolves relative models and absolute HTTPS models', async (t) => {
  let requestPath: string | undefined;
  const { url } = await server(t, (request, response) => {
    requestPath = request.url;
    assert.equal(request.headers.authorization, undefined);
    response.end(JSON.stringify([
      entry,
      { ...entry, version: 2, assets: [{ ...entry.assets[0], url: 'https://cdn.example.com/demo-v2.usdz' }] },
      { ...entry, version: 3, assets: [{ ...entry.assets[0], url: 'http://external.example.com/demo.usdz' }] },
      { ...entry, version: 4, shotType: 'other' },
      { ...entry, version: 5, assets: [{ ...entry.assets[0], sizeBytes: 0 }] },
      { ...entry, version: 6, assets: [{ ...entry.assets[0], url: 'file:///example.usdz' }] },
    ]));
  });

  const cloudFixture: typeof fetch = (input, options) => fetch(String(input).replace(cloudOrigin, url), options);
  const result = await fetchDemoCatalog(cloudOrigin, new AbortController().signal, cloudFixture);
  assert.equal(requestPath, '/v1/demos?shotType=three_point');
  assert.deepEqual(result, [{ ...modelAt(cloudOrigin, 2), url: 'https://cdn.example.com/demo-v2.usdz' }, modelAt(cloudOrigin)]);
});

test('handles bad catalog responses and a server disappearing', async (t) => {
  let status = 500;
  const { url, close } = await server(t, (_, response) => {
    response.writeHead(status).end('not JSON');
  });
  const signal = new AbortController().signal;
  const cloudFixture: typeof fetch = (input, options) => fetch(String(input).replace(cloudOrigin, url), options);
  await assert.rejects(fetchDemoCatalog(url, signal), /EXPO_PUBLIC_API_URL/);
  await assert.rejects(fetchDemoCatalog(cloudOrigin, signal, cloudFixture), /HTTP 500/);
  status = 200;
  await assert.rejects(fetchDemoCatalog(cloudOrigin, signal, cloudFixture), /invalid catalog/);
  await close();
  await assert.rejects(fetchDemoCatalog(cloudOrigin, signal, cloudFixture), /Could not reach/);
});

test('reopens a verified model and cue offline after both SQLite and the HTTP server close', async (t) => {
  const { open, demoFiles, path } = environment(t);
  const { url, close } = await server(t, (_, response) => response.end(body));
  const connection = open();
  const reports: number[] = [];
  const saved = await downloadDemo(modelAt(url), connection.store, demoFiles, (progress) => reports.push(progress), new AbortController().signal);
  assert.deepEqual(reports, [1]);
  assert.equal(demoFiles.size(saved.localPath), body.length);
  assert.equal(readdirSync(path('models')).length, 1);
  connection.close();
  await close();

  const { store } = open();
  assert.deepEqual(cachedDemo(store, demoFiles), saved);
  assert.equal(saved.cue, entry.cue);
  demoFiles.remove(saved.localPath);
  assert.equal(cachedDemo(store, demoFiles), null);
});

test('preserves the working model through a truncated update and metadata write failure', async (t) => {
  const { open, demoFiles, path } = environment(t);
  const { store } = open();
  let short = false;
  const { url } = await server(t, (_, response) => response.end(short ? body.subarray(1) : body));
  const signal = new AbortController().signal;
  const v1 = await downloadDemo(modelAt(url), store, demoFiles, () => {}, signal);
  short = true;
  await assert.rejects(downloadDemo(modelAt(url, 2), store, demoFiles, () => {}, signal), /file size/);
  assert.deepEqual(cachedDemo(store, demoFiles), v1);
  short = false;

  await assert.rejects(downloadDemo(modelAt(url, 2), {
    listDemos: () => store.listDemos(),
    saveDemo: () => { throw new Error('database write failed'); },
  }, demoFiles, () => {}, signal), /database write failed/);
  assert.deepEqual(cachedDemo(store, demoFiles), v1);
  assert.equal(readdirSync(path('models')).length, 1);

  const v2 = await downloadDemo(modelAt(url, 2), store, demoFiles, () => {}, signal);
  assert.deepEqual(cachedDemo(store, demoFiles), v2);
  assert.equal(demoFiles.size(v1.localPath), body.length);
  demoFiles.remove(v2.localPath);
  assert.deepEqual(cachedDemo(store, demoFiles), v1);
});

test('insufficient storage and interruption leave no saved entry or temporary model', async (t) => {
  const { open, demoFiles, path } = environment(t);
  const { store } = open();
  let requests = 0;
  const { url } = await server(t, (_, response) => { requests++; response.end(body); });
  const cancel = new AbortController();

  await assert.rejects(downloadDemo(modelAt(url), store, { ...demoFiles, availableBytes: () => 0 }, () => {}, cancel.signal), /Free some/);
  assert.equal(requests, 0);
  await assert.rejects(downloadDemo(modelAt(url), store, demoFiles, () => cancel.abort(), cancel.signal), /interrupted/);
  assert.equal(requests, 1);
  assert.deepEqual(readdirSync(path('models')), []);
  assert.deepEqual(store.listDemos(), []);
});
