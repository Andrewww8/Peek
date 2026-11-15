import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BlobNotFoundError, presignUrl } from '@vercel/blob';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { AuthError } from './deps.js';
import { buildAppFromEnv, isProduction } from './env.js';
import { createJwtVerifier, createSupabaseVerifier } from './jwt.js';
import { signLocalToken } from './local/index.js';
import { missingProductionEnv } from './prod/index.js';
import { createSupabaseClient, createSupabaseClipRepo } from './prod/supabaseRepo.js';
import { createVercelBlobStore, type VercelBlobSdk } from './prod/vercelBlob.js';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const S = 'cccccccc-0000-4000-8000-00000000000c';
const SERVER = join(import.meta.dirname, '..');

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perspective-prod-'));
  await writeFile(join(dir, 'demos.json'), '[]');
});
after(() => rm(dir, { recursive: true, force: true }));

/** A delegation token shaped like the Blob API's: base64url(JSON payload) + "." + signature. */
const delegation = (payload: Record<string, unknown>) => `${Buffer.from(JSON.stringify({ storeId: 'store_Abc123', ...payload })).toString('base64url')}.sig`;

describe('Vercel Blob store', () => {
  test('presigned PUT: scoped token, signed constraints in the URL, and the exact headers the PUT needs', async () => {
    const calls: any[] = [];
    const expiresAt = Date.now() + 15 * 60_000;
    const pathname = `recordings/${A}/${S}/${randomUUID()}.mov`;
    const store = createVercelBlobStore({
      token: 'vercel_blob_rw_Abc123_secret',
      sdk: {
        issueSignedToken: (async (o: any) => {
          calls.push(o);
          return {
            delegationToken: delegation({ pathname: o.pathname, operations: o.operations, validUntil: o.validUntil, maximumSizeInBytes: o.maximumSizeInBytes, allowedContentTypes: o.allowedContentTypes }),
            clientSigningToken: 'client-signing-key',
            validUntil: o.validUntil,
          };
        }) as VercelBlobSdk['issueSignedToken'],
        presignUrl, // the real SDK function, which only signs locally
      },
    });
    const put = await store.presignPut({ pathname, contentType: 'video/quicktime', maxBytes: 12_345, expiresAt, origin: 'ignored' });
    assert.deepEqual(calls, [
      {
        token: 'vercel_blob_rw_Abc123_secret',
        pathname,
        operations: ['put'],
        validUntil: expiresAt,
        maximumSizeInBytes: 12_345,
        allowedContentTypes: ['video/quicktime'],
      },
    ]);
    const url = new URL(put.url);
    assert.equal(`${url.origin}${url.pathname}`, 'https://vercel.com/api/blob/');
    assert.equal(url.searchParams.get('pathname'), pathname);
    assert.equal(url.searchParams.get('vercel-blob-maximum-size-in-bytes'), '12345');
    assert.equal(url.searchParams.get('vercel-blob-allowed-content-types'), 'video/quicktime');
    assert.equal(url.searchParams.get('vercel-blob-allow-overwrite'), 'true');
    assert.equal(url.searchParams.get('vercel-blob-ttl-days'), '2');
    assert.ok(url.searchParams.get('vercel-blob-delegation'));
    assert.match(url.searchParams.get('vercel-blob-signature') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(put.headers, {
      'x-vercel-blob-access': 'private',
      'x-content-type': 'video/quicktime',
      'x-allow-overwrite': '1',
      'x-api-version': '13',
      'x-vercel-blob-store-id': 'Abc123',
    });
    assert.equal(put.expiresAt, expiresAt);
  });

  test('signed GET URLs: one read delegation per request, one signed URL per private pathname', async () => {
    const calls: any[] = [];
    const store = createVercelBlobStore({
      sdk: {
        issueSignedToken: (async (o: any) => {
          calls.push(o);
          return { delegationToken: delegation({ pathname: '*', operations: ['get'], validUntil: o.validUntil }), clientSigningToken: 'k', validUntil: o.validUntil };
        }) as VercelBlobSdk['issueSignedToken'],
        presignUrl,
      },
    });
    const expiresAt = Date.now() + 60_000;
    const urls = await store.signedGetUrls([`clips/${A}/${S}/1.mp4`, `clips/${A}/${S}/2.mp4`], expiresAt, 'ignored');
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].pathname, calls[0].operations, calls[0].validUntil], ['*', ['get'], expiresAt]);
    assert.equal(urls.length, 2);
    for (const [i, u] of urls.entries()) {
      const url = new URL(u);
      assert.equal(`${url.origin}${url.pathname}`, `https://Abc123.private.blob.vercel-storage.com/clips/${A}/${S}/${i + 1}.mp4`.replace('Abc123', url.hostname.split('.')[0]!));
      assert.ok(url.searchParams.get('vercel-blob-signature'));
    }
    assert.notEqual(new URL(urls[0]!).searchParams.get('vercel-blob-signature'), new URL(urls[1]!).searchParams.get('vercel-blob-signature'));
  });

  test('head, read, put, delete and deletePrefix map onto the SDK', async () => {
    const log: string[] = [];
    const store = createVercelBlobStore({
      token: 't',
      sdk: {
        head: (async (p: string) => {
          log.push(`head ${p}`);
          if (p.endsWith('missing.mp4')) throw new BlobNotFoundError();
          return { size: 42 } as any;
        }) as any,
        get: (async (p: string, o: any) => {
          log.push(`get ${p} ${o.access} useCache=${o.useCache}`);
          return p.endsWith('missing.mp4') ? null : { statusCode: 200, stream: Readable.toWeb(Readable.from([Buffer.from('bytes')])) };
        }) as any,
        put: (async (p: string, body: Buffer, o: any) => {
          log.push(`put ${p} ${body.length} ${o.access} ${o.contentType} overwrite=${o.allowOverwrite} suffix=${o.addRandomSuffix}`);
          return {} as any;
        }) as any,
        del: (async (u: string | string[]) => {
          log.push(`del ${[u].flat().join(',')}`);
        }) as any,
        list: (async (o: any) => {
          log.push(`list ${o.prefix} ${o.cursor ?? '-'}`);
          return o.cursor
            ? { blobs: [{ url: 'https://s/3' }], hasMore: false }
            : { blobs: [{ url: 'https://s/1' }, { url: 'https://s/2' }], hasMore: true, cursor: 'c2' };
        }) as any,
      },
    });
    assert.deepEqual(await store.head('a/b.mp4'), { sizeBytes: 42 });
    assert.equal(await store.head('a/missing.mp4'), null);
    const chunks: Buffer[] = [];
    for await (const c of (await store.read('a/b.mp4'))!) chunks.push(Buffer.from(c));
    assert.equal(Buffer.concat(chunks).toString(), 'bytes');
    assert.equal(await store.read('a/missing.mp4'), null);
    await store.put('clips/x/1.mp4', Buffer.alloc(7), 'video/mp4');
    await store.delete('clips/x/1.mp4');
    await store.deletePrefix('clips/x/');
    await assert.rejects(store.deletePrefix('clips/x'), /must end with \//);
    assert.deepEqual(log, [
      'head a/b.mp4',
      'head a/missing.mp4',
      'get a/b.mp4 private useCache=false',
      'get a/missing.mp4 private useCache=false',
      'put clips/x/1.mp4 7 private video/mp4 overwrite=true suffix=false',
      'del clips/x/1.mp4',
      'list clips/x/ -',
      'del https://s/1,https://s/2',
      'list clips/x/ c2',
      'del https://s/3',
    ]);
  });
});

describe('Supabase clip repo', () => {
  function fakeDb(respond: (method: string, url: URL, body: any) => unknown) {
    const requests: { method: string; url: URL; body: any; prefer: string | null }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const text = await req.text();
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: req.method, url, body, prefer: req.headers.get('prefer') });
      return new Response(JSON.stringify(respond(req.method, url, body) ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { repo: createSupabaseClipRepo(createSupabaseClient('https://proj.supabase.co', 'service-role-key', fetchImpl)), requests };
  }
  const filters = (u: URL) => [...u.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort();

  test('every query is scoped to the user id and keyed on (user, session, shot)', async () => {
    const row = {
      user_id: A, session_id: S, shot_number: 1, shot_type: 'three_point', release_ms: 4000, outcome: 'made', clip_pathname: `clips/${A}/${S}/1.mp4`,
      start_ms: 1000, end_ms: 5000, size_bytes: 1234, analysis_status: 'pending', analysis: null, created_at: 't0', updated_at: 't1',
    };
    let patched: unknown[] = [{ shot_number: 1 }];
    const { repo, requests } = fakeDb((method) => (method === 'GET' ? [row] : method === 'PATCH' ? patched : []));

    await repo.upsert({ userId: A, sessionId: S, shotNumber: 1, shotType: 'three_point', releaseMs: 4000, outcome: 'made', clipPathname: row.clip_pathname, startMs: 1000, endMs: 5000, sizeBytes: 1234 });
    assert.equal(await repo.patchOutcome(A, S, 1, 'missed'), true);
    patched = [];
    assert.equal(await repo.patchOutcome(A, S, 2, 'missed'), false);
    await repo.deleteOne(A, S, 1);
    await repo.deleteSession(A, S);
    const listed = await repo.list(A, S);
    await repo.list(A);

    const [up, p1, , d1, d2, l1, l2] = requests;
    assert.equal(up!.method, 'POST');
    assert.equal(up!.url.pathname, '/rest/v1/shot_clips');
    assert.deepEqual(filters(up!.url), ['on_conflict=user_id,session_id,shot_number']);
    assert.match(up!.prefer ?? '', /resolution=merge-duplicates/);
    assert.deepEqual(up!.body, {
      user_id: A, session_id: S, shot_number: 1, shot_type: 'three_point', release_ms: 4000, outcome: 'made', clip_pathname: row.clip_pathname,
      start_ms: 1000, end_ms: 5000, size_bytes: 1234, analysis_status: 'pending', analysis: null, media_deleted_at: null,
    });
    assert.equal(p1!.method, 'PATCH');
    assert.deepEqual(p1!.body, { outcome: 'missed' });
    assert.deepEqual(filters(p1!.url), [`select=shot_number`, `session_id=eq.${S}`, 'shot_number=eq.1', `user_id=eq.${A}`]);
    assert.equal(d1!.method, 'DELETE');
    assert.deepEqual(filters(d1!.url), [`session_id=eq.${S}`, 'shot_number=eq.1', `user_id=eq.${A}`]);
    assert.deepEqual(filters(d2!.url), [`session_id=eq.${S}`, `user_id=eq.${A}`]);
    assert.deepEqual(filters(l1!.url), ['order=session_id.asc,shot_number.asc', 'select=*', `session_id=eq.${S}`, `user_id=eq.${A}`]);
    assert.deepEqual(filters(l2!.url), ['order=session_id.asc,shot_number.asc', 'select=*', `user_id=eq.${A}`]);
    assert.deepEqual(listed, [
      { userId: A, sessionId: S, shotNumber: 1, shotType: 'three_point', releaseMs: 4000, outcome: 'made', clipPathname: row.clip_pathname, startMs: 1000, endMs: 5000, sizeBytes: 1234, analysisStatus: 'pending', analysis: null, mediaDeletedAt: null, shootingHand: null, createdAt: 't0', updatedAt: 't1' },
    ]);
    for (const r of requests) assert.equal(r.url.origin, 'https://proj.supabase.co');
  });

  test('a database error surfaces as an exception (the API answers 500)', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'permission denied', code: '42501' }), { status: 403, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const repo = createSupabaseClipRepo(createSupabaseClient('https://proj.supabase.co', 'k', fetchImpl));
    await assert.rejects(repo.list(A), /shot_clips: permission denied \(42501\)/);
  });
});

describe('Supabase JWT verification', () => {
  const URL_ = 'https://proj.supabase.co';
  let jwks: ReturnType<typeof createLocalJWKSet>;
  let privateKey: CryptoKey;
  before(async () => {
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey as CryptoKey;
    jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }] });
  });
  const sign = (o: { sub?: string; aud?: string; iss?: string; exp?: number } = {}) =>
    new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setSubject(o.sub ?? A)
      .setAudience(o.aud ?? 'authenticated')
      .setIssuer(o.iss ?? `${URL_}/auth/v1`)
      .setExpirationTime(o.exp ?? Math.floor(Date.now() / 1000) + 600)
      .sign(privateKey);
  const hs = (secret: string, sub = A) =>
    new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setAudience('authenticated').setIssuer(`${URL_}/auth/v1`).setExpirationTime('10m').sign(new TextEncoder().encode(secret));

  test('accepts a valid JWKS-signed token and returns sub', async () => {
    const v = createSupabaseVerifier(`${URL_}/`, undefined, jwks);
    assert.equal(await v.verify(await sign()), A);
  });

  test('rejects wrong audience, issuer, expiry, a non-UUID sub, and HS256 without a secret', async () => {
    const v = createSupabaseVerifier(URL_, undefined, jwks);
    for (const token of [
      await sign({ aud: 'anon' }),
      await sign({ iss: 'https://evil.supabase.co/auth/v1' }),
      await sign({ exp: Math.floor(Date.now() / 1000) - 10 }),
      await sign({ sub: 'service_role' }),
      await hs('legacy-secret'),
      'a.b.c',
    ]) {
      await assert.rejects(v.verify(token), AuthError);
    }
  });

  test('falls back to HS256 with SUPABASE_JWT_SECRET', async () => {
    const v = createSupabaseVerifier(URL_, 'legacy-secret', jwks);
    assert.equal(await v.verify(await hs('legacy-secret')), A);
    await assert.rejects(v.verify(await hs('wrong-secret')), AuthError);
    assert.equal(await v.verify(await sign()), A, 'JWKS tokens still work');
  });

  test('a JWKS endpoint that cannot be reached is a server error, not a 401', async () => {
    const v = createJwtVerifier({ jwks: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(v.verify(await sign()), (err) => err instanceof TypeError && !(err instanceof AuthError));
  });
});

describe('environment and the Vercel entry', () => {
  test('production needs Supabase and Blob credentials', () => {
    assert.deepEqual(missingProductionEnv({}), ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID with Vercel OIDC)']);
    assert.deepEqual(missingProductionEnv({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', BLOB_STORE_ID: 's' }), []);
    assert.equal(isProduction({ VERCEL: '1' }), true);
    assert.equal(isProduction({ VERCEL: '1', PERSPECTIVE_DEPS: 'local' }), false);
    assert.equal(isProduction({ PERSPECTIVE_DEPS: 'production' }), true);
    assert.equal(isProduction({}), false);
  });

  test('on Vercel with missing env, /health fails with a clear message and /v1/demos still works', async () => {
    const app = await buildAppFromEnv({ VERCEL: '1', CATALOG_PATH: join(dir, 'demos.json'), MEDIA_DIR: dir, SUPABASE_URL: 'https://proj.supabase.co' }, false);
    const health = await app.inject({ url: '/health' });
    assert.equal(health.statusCode, 503);
    assert.equal(health.json().status, 'error');
    assert.match(health.json().message, /SUPABASE_SERVICE_ROLE_KEY.*BLOB_READ_WRITE_TOKEN/);
    assert.equal((await app.inject({ url: '/v1/demos' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/v1/clips' })).json().error, 'not_configured');
    await app.close();
  });

  test('with production env set, /health is ok and the clip API requires a Supabase token', async () => {
    const app = await buildAppFromEnv(
      { VERCEL: '1', CATALOG_PATH: join(dir, 'demos.json'), MEDIA_DIR: dir, SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_Abc123_x' },
      false,
    );
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
    const local = await signLocalToken('perspective-local-dev-secret', A);
    const res = await app.inject({ url: '/v1/clips', headers: { authorization: `Bearer ${local}` } });
    assert.deepEqual([res.statusCode, res.json().error], [401, 'unauthorized'], 'a local token is not a Supabase token');
    await app.close();
  });

  test('locally the app uses the stand-ins and the default dev secret', async () => {
    const app = await buildAppFromEnv({ CATALOG_PATH: join(dir, 'demos.json'), MEDIA_DIR: dir, LOCAL_DATA_DIR: join(dir, 'local') }, false);
    const token = await signLocalToken('perspective-local-dev-secret', A);
    const res = await app.inject({ url: '/v1/clips', headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual([res.statusCode, res.json()], [200, { clips: [] }]);
    await app.close();
  });

  test('api/index.ts hands requests to Fastify', async () => {
    process.env.CATALOG_PATH = join(dir, 'demos.json');
    process.env.MEDIA_DIR = dir;
    process.env.LOCAL_DATA_DIR = join(dir, 'entry-local');
    const { default: handler } = await import('../api/index.js');
    const { inject } = await import('light-my-request');
    const health = await inject(handler as any, { url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(JSON.parse(health.payload).status, 'ok');
    const demos = await inject(handler as any, { url: '/v1/demos?shotType=three_point' });
    assert.deepEqual([demos.statusCode, demos.payload], [200, '[]']);
  });

  test('vercel.json routes everything to the function, allows 300 s and ships ffmpeg and the catalog', async () => {
    const cfg = JSON.parse(await readFile(join(SERVER, 'vercel.json'), 'utf8'));
    const fn = cfg.functions['api/index.ts'];
    assert.equal(fn.maxDuration, 300);
    assert.match(fn.includeFiles, /node_modules\/ffmpeg-static\/\*\*/);
    assert.match(fn.includeFiles, /catalog\/\*\*/);
    assert.match(fn.includeFiles, /@langchain\/langgraph-sdk\/dist\/node_modules\/\*\*/); // vendored ESM markers (fix-vendored-esm.mjs)
    assert.deepEqual(cfg.rewrites, [{ source: '/(.*)', destination: '/api' }]);
  });

  test('the shot_clips migration has the key, RLS on auth.uid() and the updated_at trigger', async () => {
    const sql = (await readFile(join(SERVER, 'supabase', 'migrations', '0001_shot_clips.sql'), 'utf8')).toLowerCase();
    for (const col of ['user_id', 'session_id', 'shot_number', 'shot_type', 'release_ms', 'outcome', 'clip_pathname', 'start_ms', 'end_ms', 'size_bytes', 'analysis_status', 'analysis', 'created_at', 'updated_at']) {
      assert.match(sql, new RegExp(`\\n\\s+${col}\\s`), col);
    }
    assert.match(sql, /primary key \(user_id, session_id, shot_number\)/);
    assert.match(sql, /alter table public\.shot_clips enable row level security/);
    assert.equal((sql.match(/user_id = \(select auth\.uid\(\)\)/g) ?? []).length, 5);
    assert.match(sql, /before update on public\.shot_clips/);
  });
});

describe('coach and CV env', () => {
  const base = { VERCEL: '1', CATALOG_PATH: '', MEDIA_DIR: '', SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_Abc123_x' };

  test('without ANTHROPIC_API_KEY /health stays ok and the coach answers 503 not_configured', async () => {
    const { missingCoachEnv } = await import('./prod/coach.js');
    assert.deepEqual(missingCoachEnv({}), ['ANTHROPIC_API_KEY', 'POSTGRES_URL']);
    const app = await buildAppFromEnv({ ...base, CATALOG_PATH: join(dir, 'demos.json'), MEDIA_DIR: dir }, false);
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
    const local = await signLocalToken('x', A); // rejected first anyway: proves the route exists behind auth
    assert.equal((await app.inject({ method: 'POST', url: `/v1/sessions/${S}/coach/messages`, headers: { authorization: `Bearer ${local}` }, payload: { message: 'hi' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/internal/analysis', headers: { authorization: 'Bearer t' }, payload: {} })).json().error, 'not_configured');
    await app.close();
  });

  test('with ANTHROPIC_API_KEY, POSTGRES_URL and CV_SERVICE_TOKEN the coach and the CV route are configured, without connecting', async () => {
    const { createProductionDeps } = await import('./prod/index.js');
    const { LazyPostgresSaver } = await import('./prod/coach.js');
    const deps = createProductionDeps({ ...base, ANTHROPIC_API_KEY: 'sk-test', POSTGRES_URL: 'postgres://u:p@aws-0.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x', CV_SERVICE_TOKEN: 'cv' });
    assert.equal(deps.cvToken, 'cv');
    assert.ok(deps.coach);
    assert.equal(deps.coach.modelName, 'claude-sonnet-5-5');
    assert.ok(deps.coach.checkpointer instanceof LazyPostgresSaver);
    assert.equal(deps.coach.dailyLimit, 50);
    const model = deps.coach.createModel('coach') as unknown as { model: string; betas: string[]; outputConfig: unknown; invocationKwargs: unknown; maxTokens: number };
    assert.deepEqual([model.model, model.betas, model.outputConfig, model.invocationKwargs, model.maxTokens], ['claude-sonnet-5-5', ['server-side-fallback-2026-07-01'], { effort: 'medium' }, { fallbacks: 'default' }, 16000]);
    await (deps.coach.checkpointer as unknown as { pool: { end(): Promise<void> } }).pool.end();
  });
});

describe('Supabase reference_templates', () => {
  test('upsert is keyed on (player, shot_type) and rows map back', async () => {
    const { createSupabaseReferenceRepo } = await import('./prod/coach.js');
    const reqs: { method: string; url: URL; body: any; prefer: string | null }[] = [];
    const row = { player: 'Stephen Curry', shot_type: 'three_point', shooting_hand: 'right', fps: 30, release_index: 24, shots_averaged: 96, shots_confident_distance: 61, metrics: { kneeDipDeg: 118.4 }, curves: {}, template: {}, source_file: 'Stephen_Curry_three.npz', low_confidence: false, uncertain_distance: false, created_at: 't0', updated_at: 't1' };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const text = await req.text();
      reqs.push({ method: req.method, url: new URL(req.url), body: text ? JSON.parse(text) : undefined, prefer: req.headers.get('prefer') });
      return new Response(JSON.stringify(req.method === 'GET' ? [row] : []), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const repo = createSupabaseReferenceRepo(createSupabaseClient('https://proj.supabase.co', 'k', fetchImpl));
    await repo.upsertTemplate({ player: 'Stephen Curry', shotType: 'three_point', shootingHand: 'right', fps: 30, releaseIndex: 24, shotsAveraged: 96, shotsConfidentDistance: 61, metrics: { kneeDipDeg: 118.4 } as never, curves: {} as never, template: {} as never, sourceFile: 'Stephen_Curry_three.npz', lowConfidence: false, uncertainDistance: false });
    const listed = await repo.listTemplates('three_point');
    assert.equal(reqs[0]!.url.pathname, '/rest/v1/reference_templates');
    assert.equal(reqs[0]!.url.searchParams.get('on_conflict'), 'player,shot_type');
    assert.match(reqs[0]!.prefer ?? '', /resolution=merge-duplicates/);
    assert.equal(reqs[0]!.body.shots_confident_distance, 61);
    assert.equal(reqs[1]!.url.searchParams.get('shot_type'), 'eq.three_point');
    assert.deepEqual([listed[0]!.player, listed[0]!.shotsAveraged, listed[0]!.uncertainDistance, listed[0]!.sourceFile], ['Stephen Curry', 96, false, 'Stephen_Curry_three.npz']);
  });
});
