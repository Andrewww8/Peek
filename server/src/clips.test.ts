import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from './app.js';
import { MAX_RECORDING_BYTES, UUID } from './deps.js';
import { LOCAL_ISSUER, createLocalDeps, signLocalToken, type LocalDeps } from './local/index.js';
import { makeVideo, videoInfo } from './test-video.js';

const SECRET = 'test-secret-for-local-tokens';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';

let dir: string;
let deps: LocalDeps;
let app: FastifyInstance;
let tokenA: string;
let tokenB: string;
let six: Buffer; // 6 s, 20 fps, with audio
let silentMov: Buffer; // 6 s, no audio
let long: Buffer; // 31 s

/** Path and query of an absolute URL, for app.inject. */
const rel = (u: string) => {
  const x = new URL(u);
  return x.pathname + x.search;
};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perspective-clips-'));
  await mkdir(join(dir, 'media'));
  await writeFile(join(dir, 'demos.json'), '[]');
  await makeVideo(join(dir, 'six.mp4'), { seconds: 6, fps: 20, audio: true });
  await makeVideo(join(dir, 'silent.mov'), { seconds: 6, fps: 20, audio: false });
  await makeVideo(join(dir, 'long.mp4'), { seconds: 31, fps: 10, audio: false });
  six = await readFile(join(dir, 'six.mp4'));
  silentMov = await readFile(join(dir, 'silent.mov'));
  long = await readFile(join(dir, 'long.mp4'));
  deps = createLocalDeps(join(dir, 'local'), { jwtSecret: SECRET, inMemory: true });
  app = await buildApp({ catalogPath: join(dir, 'demos.json'), mediaDir: join(dir, 'media'), deps });
  tokenA = await signLocalToken(SECRET, A);
  tokenB = await signLocalToken(SECRET, B);
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

interface Upload {
  uploadId: string;
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  expiresAt: string;
}

async function startUpload(token: string, sessionId: string, body: Buffer, ext = 'mp4', durationMs = 6000) {
  const contentType = ext === 'mov' ? 'video/quicktime' : 'video/mp4';
  const res = await app.inject({ method: 'POST', url: '/v1/recordings', headers: auth(token), payload: { sessionId, ext, contentType, sizeBytes: body.length, durationMs } });
  assert.equal(res.statusCode, 200, res.payload);
  return res.json() as Upload;
}
function putTo(up: Upload, body: Buffer, headers: Record<string, string> = up.headers) {
  return app.inject({ method: 'PUT', url: rel(up.uploadUrl), headers, payload: body });
}
async function upload(token: string, sessionId: string, body: Buffer, ext = 'mp4', durationMs = 6000) {
  const up = await startUpload(token, sessionId, body, ext, durationMs);
  const put = await putTo(up, body);
  assert.equal(put.statusCode, 200, put.payload);
  return up;
}
const cut = (token: string, uploadId: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/v1/recordings/${uploadId}/clips`, headers: auth(token), payload: payload as object });
const exists = (pathname: string) => stat(deps.blob.fileOf(pathname)).then(() => true, () => false);
const listClips = async (token: string, sessionId?: string) => {
  const res = await app.inject({ url: `/v1/clips${sessionId ? `?sessionId=${sessionId}` : ''}`, headers: auth(token) });
  assert.equal(res.statusCode, 200, res.payload);
  return res.json().clips as any[];
};
const shots = [
  { shotNumber: 1, releaseMs: 4000, outcome: 'made' },
  { shotNumber: 2, releaseMs: 1000, outcome: 'missed' },
  { shotNumber: 3, releaseMs: 6000, outcome: 'unmarked' },
];

describe('authentication', () => {
  const sessionId = randomUUID();
  const endpoints = () => [
    { method: 'POST' as const, url: '/v1/recordings', payload: { sessionId, ext: 'mp4', contentType: 'video/mp4', sizeBytes: 10, durationMs: 10 } },
    { method: 'POST' as const, url: `/v1/recordings/${randomUUID()}/clips`, payload: { sessionId, shotType: 'three_point', shots } },
    { method: 'PATCH' as const, url: `/v1/sessions/${sessionId}/shots/1`, payload: { outcome: 'made' } },
    { method: 'DELETE' as const, url: `/v1/sessions/${sessionId}/shots/1` },
    { method: 'DELETE' as const, url: `/v1/sessions/${sessionId}` },
    { method: 'GET' as const, url: `/v1/clips?sessionId=${sessionId}` },
  ];
  const sign = (claims: Record<string, unknown>, opts: { secret?: string; sub?: string; aud?: string; exp?: number; alg?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
      .setSubject(opts.sub ?? A)
      .setAudience(opts.aud ?? 'authenticated')
      .setIssuer(LOCAL_ISSUER)
      .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 600)
      .sign(new TextEncoder().encode(opts.secret ?? SECRET));

  test('every clip endpoint answers 401 unauthorized without a valid token', async () => {
    const unsignedNone = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: A, aud: 'authenticated' })).toString('base64url')}.`;
    const bad: Record<string, string | undefined> = {
      missing: undefined,
      notBearer: `Basic ${tokenA}`,
      empty: 'Bearer ',
      garbage: 'Bearer not.a.jwt',
      wrongSecret: `Bearer ${await sign({}, { secret: 'another-secret' })}`,
      expired: `Bearer ${await signLocalToken(SECRET, A, -60)}`,
      wrongAudience: `Bearer ${await sign({}, { aud: 'anon' })}`,
      subNotUuid: `Bearer ${await sign({}, { sub: 'admin' })}`,
      algNone: `Bearer ${unsignedNone}`,
    };
    for (const e of endpoints()) {
      for (const [name, header] of Object.entries(bad)) {
        const res = await app.inject({ ...e, headers: header === undefined ? {} : { authorization: header } });
        assert.equal(res.statusCode, 401, `${e.method} ${e.url} with ${name} -> ${res.statusCode}`);
        assert.equal(res.json().error, 'unauthorized');
      }
    }
  });

  test('public endpoints stay public', async () => {
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/v1/demos' })).statusCode, 200);
  });

  test('without deps the clip API answers 503 not_configured, and /health reports a production misconfiguration', async () => {
    const bare = await buildApp({ catalogPath: join(dir, 'demos.json'), mediaDir: join(dir, 'media') });
    assert.equal((await bare.inject({ url: '/v1/clips', headers: auth(tokenA) })).json().error, 'not_configured');
    assert.equal((await bare.inject({ url: '/health' })).statusCode, 200);
    await bare.close();
    const broken = await buildApp({ catalogPath: join(dir, 'demos.json'), mediaDir: join(dir, 'media'), depsError: 'missing environment variables: SUPABASE_URL' });
    const health = await broken.inject({ url: '/health' });
    assert.equal(health.statusCode, 503);
    assert.equal(health.json().status, 'error');
    assert.match(health.json().message, /SUPABASE_URL/);
    const clips = await broken.inject({ url: '/v1/clips', headers: auth(tokenA) });
    assert.equal(clips.statusCode, 503);
    assert.deepEqual([clips.json().error, clips.json().message], ['not_configured', 'missing environment variables: SUPABASE_URL']);
    assert.equal((await broken.inject({ url: '/v1/demos' })).statusCode, 200);
    await broken.close();
  });
});

describe('POST /v1/recordings', () => {
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/recordings', headers: auth(tokenA), payload: payload as object });
  const ok = { sessionId: randomUUID(), ext: 'mov', contentType: 'video/quicktime', sizeBytes: 1000, durationMs: 5000 };

  test('issues a presigned PUT for the user-scoped recording path', async () => {
    const res = await post(ok);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'headers', 'method', 'uploadId', 'uploadUrl']);
    assert.match(body.uploadId, UUID);
    assert.equal(body.method, 'PUT');
    assert.deepEqual(body.headers, { 'x-vercel-blob-access': 'private', 'x-content-type': 'video/quicktime', 'x-allow-overwrite': '1' });
    const ttl = Date.parse(body.expiresAt) - Date.now();
    assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000, `expires in ${ttl} ms`);
    assert.notEqual((await post(ok)).json().uploadId, body.uploadId, 'each call gets a fresh uploadId');
  });

  test('enforces the 60 MB and 30 s caps with precise codes', async () => {
    assert.equal((await post({ ...ok, sizeBytes: MAX_RECORDING_BYTES })).statusCode, 200);
    assert.equal((await post({ ...ok, durationMs: 30_000 })).statusCode, 200);
    assert.equal((await post({ ...ok, durationMs: null })).statusCode, 200, 'unknown duration is accepted');
    const big = await post({ ...ok, sizeBytes: MAX_RECORDING_BYTES + 1 });
    assert.deepEqual([big.statusCode, big.json().error], [413, 'recording_too_large']);
    const longer = await post({ ...ok, durationMs: 30_001 });
    assert.deepEqual([longer.statusCode, longer.json().error], [422, 'recording_too_long']);
  });

  test('rejects malformed requests', async () => {
    const cases: [unknown, number, string][] = [
      [{ ...ok, sessionId: 'session-1' }, 400, 'invalid_request'],
      [{ ...ok, sessionId: `../${A}` }, 400, 'invalid_request'],
      [{ ...ok, sessionId: undefined }, 400, 'invalid_request'],
      [{ ...ok, ext: 'avi' }, 415, 'unsupported_media_type'],
      [{ ...ok, ext: 'mov/../../x' }, 415, 'unsupported_media_type'],
      [{ ...ok, contentType: 'image/png' }, 415, 'unsupported_media_type'],
      [{ ...ok, sizeBytes: 0 }, 400, 'invalid_request'],
      [{ ...ok, sizeBytes: 1.5 }, 400, 'invalid_request'],
      [{ ...ok, sizeBytes: '1000' }, 400, 'invalid_request'],
      [{ ...ok, durationMs: 0 }, 400, 'invalid_request'],
      [{ ...ok, durationMs: '5000' }, 400, 'invalid_request'],
      [[ok], 400, 'invalid_request'],
    ];
    for (const [payload, status, error] of cases) {
      const res = await post(payload);
      assert.deepEqual([res.statusCode, res.json().error], [status, error], JSON.stringify(payload));
    }
    const notJson = await app.inject({ method: 'POST', url: '/v1/recordings', headers: { ...auth(tokenA), 'content-type': 'application/json' }, payload: '{"sessionId":' });
    assert.deepEqual([notJson.statusCode, notJson.json().error], [400, 'invalid_request']);
  });
});

describe('local presigned PUT', () => {
  test('stores the body at recordings/<userId>/<sessionId>/<uploadId>.<ext>', async () => {
    const sessionId = randomUUID();
    const up = await upload(tokenA, sessionId, six);
    const stored = await readFile(deps.blob.fileOf(`recordings/${A}/${sessionId}/${up.uploadId}.mp4`));
    assert.ok(stored.equals(six));
    assert.equal((await putTo(up, six)).statusCode, 200, 'a retried PUT of the same upload succeeds');
  });

  test('enforces the declared size, content type, headers, signature and expiry', async () => {
    const sessionId = randomUUID();
    const up = await startUpload(tokenA, sessionId, Buffer.alloc(100));
    const tooBig = await putTo(up, Buffer.alloc(101));
    assert.deepEqual([tooBig.statusCode, tooBig.json().error], [413, 'file_too_large']);
    const noAccess = await putTo(up, Buffer.alloc(100), { 'x-content-type': 'video/mp4' });
    assert.equal(noAccess.statusCode, 400);
    const wrongType = await putTo(up, Buffer.alloc(100), { ...up.headers, 'x-content-type': 'video/quicktime' });
    assert.deepEqual([wrongType.statusCode, wrongType.json().error], [400, 'content_type_not_allowed']);
    const path = rel(up.uploadUrl);
    const tampered = await app.inject({ method: 'PUT', url: path.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), headers: up.headers, payload: Buffer.alloc(100) });
    assert.deepEqual([tampered.statusCode, tampered.json().error], [403, 'invalid_signature']);
    assert.equal(await exists(`recordings/${A}/${sessionId}/${up.uploadId}.mp4`), false, 'nothing stored by the rejected PUTs');

    const soon = await deps.blob.presignPut({ pathname: `recordings/${A}/${sessionId}/x.mp4`, contentType: 'video/mp4', maxBytes: 10, expiresAt: Date.now() + 30, origin: 'http://localhost' });
    await new Promise((r) => setTimeout(r, 60));
    const expired = await app.inject({ method: 'PUT', url: rel(soon.url), headers: soon.headers, payload: Buffer.alloc(5) });
    assert.deepEqual([expired.statusCode, expired.json().error], [403, 'expired']);

    const [getUrl] = await deps.blob.signedGetUrls([`recordings/${A}/${sessionId}/x.mp4`], Date.now() + 60_000, 'http://localhost');
    const putWithGet = await app.inject({ method: 'PUT', url: rel(getUrl!), headers: soon.headers, payload: Buffer.alloc(5) });
    assert.deepEqual([putWithGet.statusCode, putWithGet.json().error], [403, 'operation_not_allowed']);
  });
});

describe('POST /v1/recordings/:uploadId/clips', () => {
  test('cuts one clip per shot with the brief window, stores rows, then deletes the recording', async () => {
    const sessionId = randomUUID();
    const up = await upload(tokenA, sessionId, six);
    const res = await cut(tokenA, up.uploadId, { sessionId, shotType: 'three_point', shots });
    assert.equal(res.statusCode, 200, res.payload);
    const out = res.json().clips;
    assert.deepEqual(
      out.map((c: any) => [c.shotNumber, c.startMs, c.endMs]),
      [
        [1, 1000, 5000],
        [2, 0, 2000],
        [3, 3000, 6000],
      ],
    );
    for (const c of out) {
      const file = deps.blob.fileOf(`clips/${A}/${sessionId}/${c.shotNumber}.mp4`);
      assert.equal((await stat(file)).size, c.sizeBytes);
      const info = await videoInfo(file);
      assert.ok(Math.abs(info.frames - ((c.endMs - c.startMs) * 20) / 1000) <= 1);
      assert.deepEqual([info.videoCodec, info.audioCodec], ['h264', 'aac']);
    }
    assert.equal(await exists(`recordings/${A}/${sessionId}/${up.uploadId}.mp4`), false, 'recording deleted after the clips were stored');
    const rows = deps.clips.rows().filter((r) => r.sessionId === sessionId);
    assert.deepEqual(
      rows.map((r) => [r.userId, r.shotNumber, r.shotType, r.releaseMs, r.outcome, r.clipPathname, r.analysisStatus]),
      shots.map((s) => [A, s.shotNumber, 'three_point', s.releaseMs, s.outcome, `clips/${A}/${sessionId}/${s.shotNumber}.mp4`, 'pending']),
    );
  });

  test('is idempotent: a retry returns the same clips without re-cutting and takes the latest outcome', async () => {
    const sessionId = randomUUID();
    const up = await upload(tokenA, sessionId, six);
    const first = await cut(tokenA, up.uploadId, { sessionId, shotType: 'three_point', shots });
    const clipFile = deps.blob.fileOf(`clips/${A}/${sessionId}/1.mp4`);
    const before = (await stat(clipFile)).mtimeMs;
    const retried = shots.map((s) => (s.shotNumber === 1 ? { ...s, outcome: 'missed' } : s));
    const again = await cut(tokenA, up.uploadId, { sessionId, shotType: 'three_point', shots: retried });
    assert.equal(again.statusCode, 200, again.payload);
    assert.deepEqual(again.json(), first.json());
    assert.equal((await stat(clipFile)).mtimeMs, before, 'not re-cut');
    assert.equal(deps.clips.rows().find((r) => r.sessionId === sessionId && r.shotNumber === 1)!.outcome, 'missed');
    assert.equal(deps.clips.rows().filter((r) => r.sessionId === sessionId).length, 3);

    // The phone re-uploads after a crash between storing the clips and deleting the recording.
    const second = await upload(tokenA, sessionId, six);
    const third = await cut(tokenA, second.uploadId, { sessionId, shotType: 'three_point', shots: retried });
    assert.equal(third.statusCode, 200);
    assert.equal(await exists(`recordings/${A}/${sessionId}/${second.uploadId}.mp4`), false);
    assert.equal((await stat(clipFile)).mtimeMs, before);

    // A later batch with one new shot cuts only that one.
    const fourth = await upload(tokenA, sessionId, six);
    const more = await cut(tokenA, fourth.uploadId, { sessionId, shotType: 'three_point', shots: [...retried, { shotNumber: 4, releaseMs: 2500, outcome: 'made' }] });
    assert.equal(more.statusCode, 200);
    assert.deepEqual(more.json().clips.at(-1), { shotNumber: 4, startMs: 0, endMs: 3500, sizeBytes: more.json().clips.at(-1).sizeBytes });
    assert.equal((await stat(clipFile)).mtimeMs, before);
  });

  test('works for a .mov recording without an audio track', async () => {
    const sessionId = randomUUID();
    const up = await upload(tokenA, sessionId, silentMov, 'mov');
    const res = await cut(tokenA, up.uploadId, { sessionId, shotType: 'three_point', shots: [{ shotNumber: 1, releaseMs: 3000, outcome: 'made' }] });
    assert.equal(res.statusCode, 200, res.payload);
    const info = await videoInfo(deps.blob.fileOf(`clips/${A}/${sessionId}/1.mp4`));
    assert.deepEqual([info.videoCodec, info.audioCodec], ['h264', null]);
    assert.equal(await exists(`recordings/${A}/${sessionId}/${up.uploadId}.mov`), false);
  });

  test('a release beyond the duration gets a per-shot error; the other shots are still cut', async () => {
    const sessionId = randomUUID();
    const up = await upload(tokenA, sessionId, six);
    const res = await cut(tokenA, up.uploadId, { sessionId, shotType: 'three_point', shots: [shots[0], { shotNumber: 9, releaseMs: 6001, outcome: 'made' }] });
    assert.equal(res.statusCode, 200, res.payload);
    const [ok, late] = res.json().clips;
    assert.deepEqual([ok.shotNumber, ok.startMs, ok.endMs], [1, 1000, 5000]);
    assert.deepEqual(late, { shotNumber: 9, error: 'release_beyond_duration', message: 'shot 9 releases at 6001 ms, after the end (6000 ms)', durationMs: 6000 });
    assert.deepEqual(deps.clips.rows().filter((r) => r.sessionId === sessionId).map((r) => r.shotNumber), [1]);
    assert.equal(await exists(`clips/${A}/${sessionId}/9.mp4`), false);
    assert.equal(await exists(`recordings/${A}/${sessionId}/${up.uploadId}.mp4`), false);
  });

  test('durationMs null (session recovered after a kill) is accepted; the cut uses the probed duration', async () => {
    const sessionId = randomUUID();
    const up = await startUpload(tokenA, sessionId, six, 'mp4', null as unknown as number);
    assert.equal((await putTo(up, six)).statusCode, 200);
    const res = await cut(tokenA, up.uploadId, { sessionId, shotType: 'three_point', shots: [{ shotNumber: 1, releaseMs: 5800, outcome: 'made' }] });
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual([res.json().clips[0].startMs, res.json().clips[0].endMs], [2800, 6000], 'end clamped to the real 6 s');
  });

  test('cutting a new upload also deletes older uploads of the same session', async () => {
    const sessionId = randomUUID();
    const orphan = await upload(tokenA, sessionId, six); // app killed after this PUT
    const otherSession = randomUUID();
    const unrelated = await upload(tokenA, otherSession, six);
    const fresh = await upload(tokenA, sessionId, six);
    assert.equal((await cut(tokenA, fresh.uploadId, { sessionId, shotType: 'three_point', shots: [shots[0]] })).statusCode, 200);
    assert.equal(await exists(`recordings/${A}/${sessionId}/${orphan.uploadId}.mp4`), false);
    assert.equal(await exists(`recordings/${A}/${sessionId}/${fresh.uploadId}.mp4`), false);
    assert.equal(await exists(`recordings/${A}/${otherSession}/${unrelated.uploadId}.mp4`), true, 'other sessions untouched');
  });

  test('a recording longer than 30 s or not a video is refused with its own code', async () => {
    const sessionId = randomUUID();
    const tooLong = await upload(tokenA, sessionId, long, 'mp4', 30_000);
    const r1 = await cut(tokenA, tooLong.uploadId, { sessionId, shotType: 'three_point', shots: [shots[0]] });
    assert.deepEqual([r1.statusCode, r1.json().error], [422, 'recording_too_long']);
    const junk = await upload(tokenA, sessionId, Buffer.alloc(5000, 9));
    const r2 = await cut(tokenA, junk.uploadId, { sessionId, shotType: 'three_point', shots: [shots[0]] });
    assert.deepEqual([r2.statusCode, r2.json().error], [422, 'recording_unreadable']);
    assert.equal(deps.clips.rows().filter((r) => r.sessionId === sessionId).length, 0);
  });

  test('404 recording_not_found for an unknown upload, and for another user\'s upload', async () => {
    const sessionId = randomUUID();
    const missing = await cut(tokenA, randomUUID(), { sessionId, shotType: 'three_point', shots });
    assert.deepEqual([missing.statusCode, missing.json().error], [404, 'recording_not_found']);

    const up = await upload(tokenA, sessionId, six);
    const stolen = await cut(tokenB, up.uploadId, { sessionId, shotType: 'three_point', shots });
    assert.deepEqual([stolen.statusCode, stolen.json().error], [404, 'recording_not_found']);
    assert.equal(await exists(`recordings/${A}/${sessionId}/${up.uploadId}.mp4`), true, "A's recording untouched");
    assert.equal(deps.clips.rows().filter((r) => r.sessionId === sessionId).length, 0);
  });

  test('rejects malformed requests with invalid_request', async () => {
    const sessionId = randomUUID();
    const s = shots[0];
    const bodies = [
      { sessionId: 'x', shotType: 'three_point', shots },
      { sessionId, shotType: 'Three-Point', shots },
      { sessionId, shotType: 'three_point', shots: [] },
      { sessionId, shotType: 'three_point', shots: 'all' },
      { sessionId, shotType: 'three_point', shots: [s, s] },
      { sessionId, shotType: 'three_point', shots: [{ ...s, shotNumber: 0 }] },
      { sessionId, shotType: 'three_point', shots: [{ ...s, releaseMs: -1 }] },
      { sessionId, shotType: 'three_point', shots: [{ ...s, releaseMs: 1.5 }] },
      { sessionId, shotType: 'three_point', shots: [{ ...s, outcome: 'swish' }] },
      { sessionId, shotType: 'three_point', shots: Array.from({ length: 201 }, (_, i) => ({ ...s, shotNumber: i + 1 })) },
    ];
    for (const b of bodies) {
      const res = await cut(tokenA, randomUUID(), b);
      assert.deepEqual([res.statusCode, res.json().error], [400, 'invalid_request'], JSON.stringify(b).slice(0, 120));
    }
    const badId = await cut(tokenA, 'not-a-uuid', { sessionId, shotType: 'three_point', shots });
    assert.deepEqual([badId.statusCode, badId.json().error], [400, 'invalid_request']);
  });
});

describe('PATCH, DELETE and GET', () => {
  let sessionA: string;
  before(async () => {
    sessionA = randomUUID();
    const up = await upload(tokenA, sessionA, six);
    assert.equal((await cut(tokenA, up.uploadId, { sessionId: sessionA, shotType: 'three_point', shots })).statusCode, 200);
  });

  test('GET /v1/clips lists only the caller\'s clips, with working short-lived URLs', async () => {
    const mine = await listClips(tokenA, sessionA);
    assert.deepEqual(mine.map((c) => c.shotNumber), [1, 2, 3]);
    assert.deepEqual(Object.keys(mine[0]).sort(), [
      'analysisStatus', 'createdAt', 'endMs', 'outcome', 'releaseMs', 'sessionId', 'shotNumber', 'shotType', 'sizeBytes', 'startMs', 'updatedAt', 'url', 'urlExpiresAt',
    ]);
    const got = await app.inject({ url: rel(mine[0].url) });
    assert.equal(got.statusCode, 200);
    assert.equal(got.headers['content-type'], 'video/mp4');
    assert.ok(got.rawPayload.equals(await readFile(deps.blob.fileOf(`clips/${A}/${sessionA}/1.mp4`))));
    assert.deepEqual(await listClips(tokenB, sessionA), [], "B sees nothing of A's session");
    assert.ok((await listClips(tokenA)).some((c) => c.sessionId === sessionA), 'without sessionId: all of the caller\'s clips');
    const bad = await app.inject({ url: '/v1/clips?sessionId=nope', headers: auth(tokenA) });
    assert.deepEqual([bad.statusCode, bad.json().error], [400, 'invalid_request']);

    const [soon] = await deps.blob.signedGetUrls([`clips/${A}/${sessionA}/1.mp4`], Date.now() + 30, 'http://localhost');
    await new Promise((r) => setTimeout(r, 60));
    const expired = await app.inject({ url: rel(soon!) });
    assert.deepEqual([expired.statusCode, expired.json().error], [403, 'expired']);
  });

  test('PATCH updates the outcome, 404 for a missing shot or another user\'s shot', async () => {
    const patch = (token: string, url: string, payload: unknown) => app.inject({ method: 'PATCH', url, headers: auth(token), payload: payload as object });
    const ok = await patch(tokenA, `/v1/sessions/${sessionA}/shots/2`, { outcome: 'made' });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { sessionId: sessionA, shotNumber: 2, outcome: 'made' });
    assert.equal((await listClips(tokenA, sessionA))[1].outcome, 'made');

    const other = await patch(tokenB, `/v1/sessions/${sessionA}/shots/2`, { outcome: 'missed' });
    assert.deepEqual([other.statusCode, other.json().error], [404, 'clip_not_found']);
    assert.equal((await listClips(tokenA, sessionA))[1].outcome, 'made', "B could not change A's shot");
    const missing = await patch(tokenA, `/v1/sessions/${sessionA}/shots/99`, { outcome: 'made' });
    assert.deepEqual([missing.statusCode, missing.json().error], [404, 'clip_not_found']);
    for (const [url, body] of [
      [`/v1/sessions/${sessionA}/shots/2`, { outcome: 'swish' }],
      [`/v1/sessions/${sessionA}/shots/0`, { outcome: 'made' }],
      [`/v1/sessions/${sessionA}/shots/abc`, { outcome: 'made' }],
      [`/v1/sessions/${sessionA}/shots/1.5`, { outcome: 'made' }],
      ['/v1/sessions/nope/shots/1', { outcome: 'made' }],
    ] as const) {
      const res = await patch(tokenA, url, body);
      assert.deepEqual([res.statusCode, res.json().error], [400, 'invalid_request'], url);
    }
  });

  test('DELETE of one shot removes its row and clip, is idempotent, and cannot touch another user', async () => {
    const del = (token: string, url: string) => app.inject({ method: 'DELETE', url, headers: auth(token) });
    assert.equal((await del(tokenB, `/v1/sessions/${sessionA}/shots/3`)).statusCode, 204);
    assert.equal(await exists(`clips/${A}/${sessionA}/3.mp4`), true, "B's delete did not reach A's clip");
    assert.equal((await del(tokenA, `/v1/sessions/${sessionA}/shots/3`)).statusCode, 204);
    assert.equal(await exists(`clips/${A}/${sessionA}/3.mp4`), false);
    assert.deepEqual((await listClips(tokenA, sessionA)).map((c) => c.shotNumber), [1, 2]);
    assert.equal((await del(tokenA, `/v1/sessions/${sessionA}/shots/3`)).statusCode, 204, 'idempotent');
  });

  test('DELETE of a session removes every clip, row and leftover recording, idempotently', async () => {
    const del = (token: string, url: string) => app.inject({ method: 'DELETE', url, headers: auth(token) });
    const leftover = await upload(tokenA, sessionA, six); // uploaded but never cut
    assert.equal((await del(tokenB, `/v1/sessions/${sessionA}`)).statusCode, 204);
    assert.equal((await listClips(tokenA, sessionA)).length, 2, "B's delete did not reach A's session");
    assert.equal((await del(tokenA, `/v1/sessions/${sessionA}`)).statusCode, 204);
    assert.deepEqual(await listClips(tokenA, sessionA), []);
    assert.equal(await exists(`clips/${A}/${sessionA}/1.mp4`), false);
    assert.equal(await exists(`recordings/${A}/${sessionA}/${leftover.uploadId}.mp4`), false);
    assert.equal((await del(tokenA, `/v1/sessions/${sessionA}`)).statusCode, 204, 'idempotent');
    const bad = await del(tokenA, '/v1/sessions/..%2F..%2Fclips');
    assert.deepEqual([bad.statusCode, bad.json().error], [400, 'invalid_request']);
  });
});
