import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, closeWithin } from './app.js';
import { placeholderUsdz } from '../scripts/make-placeholder-usdz.js';

const FILE = 'three-point-follow-through-v1.usdz';
const SECRET_OUTSIDE = 'SECRET-OUTSIDE-MEDIA';
const SECRET_DOTFILE = 'SECRET-DOTFILE';

const threePoint = (sizeBytes: number) => ({
  id: 'three-point-follow-through',
  version: 1,
  shotType: 'three_point',
  cue: 'Hold your finish until the ball reaches the rim.',
  assets: [{ format: 'usdz', sizeBytes, url: `/media/${FILE}` }],
});
const freeThrow = {
  id: 'free-throw-setup',
  version: 1,
  shotType: 'free_throw',
  cue: 'Set your feet.',
  assets: [{ format: 'usdz', sizeBytes: 10, url: 'https://cdn.example.com/free-throw-setup-v1.usdz' }],
};

/** A logger that keeps parsed JSON log lines, so tests can assert on warnings. */
function captureLogs() {
  const lines: { level: number; msg: string }[] = [];
  return { lines, logger: { level: 'warn', stream: { write: (s: string) => void lines.push(JSON.parse(s)) } } };
}

let dir: string;
let mediaDir: string;
let catalogPath: string;
let usdz: Buffer;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perspective-app-'));
  mediaDir = join(dir, 'media');
  catalogPath = join(dir, 'catalog', 'demos.json');
  await mkdir(mediaDir);
  await mkdir(join(dir, 'catalog'));
  usdz = placeholderUsdz();
  await writeFile(join(mediaDir, FILE), usdz);
  await writeFile(join(mediaDir, '.gitkeep'), '');
  await writeFile(join(mediaDir, '.secret'), SECRET_DOTFILE);
  await mkdir(join(mediaDir, 'sub'));
  await writeFile(join(dir, 'secret.txt'), SECRET_OUTSIDE);
  await writeFile(catalogPath, JSON.stringify([threePoint(usdz.length), freeThrow], null, 2));
});
after(() => rm(dir, { recursive: true, force: true }));

describe('API', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildApp({ catalogPath, mediaDir });
  });
  after(() => app.close());

  test('GET /health answers ok with the service name and a timestamp', async () => {
    const res = await app.inject({ url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /^application\/json/);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['service', 'status', 'time']);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'perspective-api');
    assert.equal(new Date(body.time).toISOString(), body.time);
  });

  test('GET /v1/demos without shotType returns every entry', async () => {
    const res = await app.inject({ url: '/v1/demos' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), [threePoint(usdz.length), freeThrow]);
  });

  test('GET /v1/demos?shotType= returns only the matching entries', async () => {
    const three = await app.inject({ url: '/v1/demos?shotType=three_point' });
    assert.equal(three.statusCode, 200);
    assert.deepEqual(three.json(), [threePoint(usdz.length)]);
    const free = await app.inject({ url: '/v1/demos', query: { shotType: 'free_throw' } });
    assert.deepEqual(free.json(), [freeThrow]);
    const none = await app.inject({ url: '/v1/demos?shotType=layup' });
    assert.equal(none.statusCode, 200);
    assert.deepEqual(none.json(), []);
  });

  test('GET /v1/demos rejects an invalid shotType with 400', async () => {
    const bad = ['../../etc', 'Three_Point', 'three-point', '', 'a'.repeat(65), '%00', 'three_point%0A'];
    for (const v of bad) {
      const res = await app.inject({ url: `/v1/demos?shotType=${encodeURIComponent(v)}` });
      assert.equal(res.statusCode, 400, `shotType=${v}`);
      assert.equal(res.json().code, 'FST_ERR_VALIDATION');
    }
    const twice = await app.inject({ url: '/v1/demos?shotType=three_point&shotType=free_throw' });
    assert.equal(twice.statusCode, 400);
  });
});

describe('/v1/demos with a broken catalog', () => {
  let app: FastifyInstance;
  let path: string;
  before(async () => {
    path = join(dir, 'catalog', 'broken.json');
    app = await buildApp({ catalogPath: path, mediaDir });
  });
  after(() => app.close());

  const assertNoPath = (payload: string) => {
    assert.ok(!payload.includes(dir), `response leaks a file system path: ${payload}`);
  };

  test('missing catalog file -> 500 catalog_invalid without the path', async () => {
    const res = await app.inject({ url: '/v1/demos?shotType=three_point' });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: 'catalog_invalid', message: 'catalog unreadable' });
    assertNoPath(res.payload);
  });

  test('catalog that fails validation -> 500 catalog_invalid naming the problem', async () => {
    await writeFile(path, JSON.stringify([{ ...threePoint(usdz.length), version: 0 }]));
    const res = await app.inject({ url: '/v1/demos' });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, 'catalog_invalid');
    assert.match(res.json().message, /^catalog\[0\]: version must be a positive integer/);
    assertNoPath(res.payload);
  });

  test('malformed JSON -> 500 catalog_invalid', async () => {
    await writeFile(path, '[{"id": "three-point-follow-through",');
    const res = await app.inject({ url: '/v1/demos' });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: 'catalog_invalid', message: 'catalog unreadable' });
    assertNoPath(res.payload);
  });

  test('fixing the file recovers without a restart', async () => {
    await writeFile(path, JSON.stringify([threePoint(usdz.length)]));
    const res = await app.inject({ url: '/v1/demos?shotType=three_point' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), [threePoint(usdz.length)]);
  });
});

describe('/media/', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildApp({ catalogPath, mediaDir });
  });
  after(() => app.close());

  test('serves the exact bytes with Content-Length, the usdz type and an immutable Cache-Control', async () => {
    const res = await app.inject({ url: `/media/${FILE}` });
    assert.equal(res.statusCode, 200);
    assert.ok(res.rawPayload.equals(usdz), 'served bytes differ from the export');
    assert.equal(res.headers['content-length'], String(usdz.length));
    assert.equal(res.headers['content-type'], 'model/vnd.usdz+zip');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(res.headers['accept-ranges'], 'bytes');
  });

  test('supports Range requests so a download can resume', async () => {
    const head = await app.inject({ url: `/media/${FILE}`, headers: { range: 'bytes=0-99' } });
    assert.equal(head.statusCode, 206);
    assert.equal(head.headers['content-range'], `bytes 0-99/${usdz.length}`);
    assert.equal(head.headers['content-length'], '100');
    assert.equal(head.headers['content-type'], 'model/vnd.usdz+zip');
    assert.ok(head.rawPayload.equals(usdz.subarray(0, 100)));

    const rest = await app.inject({ url: `/media/${FILE}`, headers: { range: 'bytes=100-' } });
    assert.equal(rest.statusCode, 206);
    assert.equal(rest.headers['content-range'], `bytes 100-${usdz.length - 1}/${usdz.length}`);
    assert.equal(rest.headers['content-length'], String(usdz.length - 100));
    assert.ok(Buffer.concat([head.rawPayload, rest.rawPayload]).equals(usdz), 'resumed download differs from the export');

    const past = await app.inject({ url: `/media/${FILE}`, headers: { range: `bytes=${usdz.length}-` } });
    assert.equal(past.statusCode, 416);
    assert.equal(past.headers['content-range'], `bytes */${usdz.length}`);
  });

  test('honours If-Range, which iOS sends when it resumes a download', async () => {
    const full = await app.inject({ url: `/media/${FILE}` });
    const etag = full.headers.etag as string;
    const lastModified = full.headers['last-modified'] as string;
    assert.ok(etag && lastModified, 'a validator is required for NSURLSession resume data');

    for (const ifRange of [etag, lastModified]) {
      const res = await app.inject({ url: `/media/${FILE}`, headers: { range: 'bytes=100-', 'if-range': ifRange } });
      assert.equal(res.statusCode, 206, `If-Range: ${ifRange}`);
      assert.ok(res.rawPayload.equals(usdz.subarray(100)));
    }
    // The file changed since the partial download: send the whole file again.
    const stale = await app.inject({ url: `/media/${FILE}`, headers: { range: 'bytes=100-', 'if-range': 'W/"0-0"' } });
    assert.equal(stale.statusCode, 200);
    assert.ok(stale.rawPayload.equals(usdz));
  });

  test('answers HEAD with the headers and no body', async () => {
    const res = await app.inject({ method: 'HEAD', url: `/media/${FILE}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-length'], String(usdz.length));
    assert.equal(res.headers['content-type'], 'model/vnd.usdz+zip');
    assert.equal(res.rawPayload.length, 0);
  });

  test('404 for a missing file, without the immutable header', async () => {
    const res = await app.inject({ url: '/media/three-point-follow-through-v9.usdz' });
    assert.equal(res.statusCode, 404);
    assert.ok(!String(res.headers['cache-control'] ?? '').includes('immutable'));
    assert.ok(!res.payload.includes(dir));
  });

  test('path traversal never escapes media/', async () => {
    const attempts = [
      '/media/../secret.txt',
      '/media/..%2Fsecret.txt',
      '/media/..%2fsecret.txt',
      '/media/..%2F..%2F' + encodeURIComponent(dir.slice(1)) + '%2Fsecret.txt',
      '/media/%2e%2e/secret.txt',
      '/media/%2e%2e%2fsecret.txt',
      '/media/.%2e/secret.txt',
      '/media/..%2Fcatalog%2Fdemos.json',
      '/media/%252e%252e%252fsecret.txt', // double-encoded
      '/media/..%252fsecret.txt',
      '/media/%252e%252e%252fcatalog%252fdemos.json',
      '/media/..\\secret.txt', // backslashes
      '/media/..%5csecret.txt',
      '/media/..%5c..%5csecret.txt',
      '/media/%5c..%5csecret.txt',
      '/media/%255c..%255csecret.txt',
      '/media/sub/..%2F..%2Fsecret.txt',
      `/media/${FILE}/..%2F..%2Fsecret.txt`,
      '/media//../secret.txt',
      '/media/%00../secret.txt',
      `/media/${FILE}%00`,
    ];
    for (const url of attempts) {
      const res = await app.inject({ url });
      assert.ok([400, 403, 404].includes(res.statusCode), `${url} -> ${res.statusCode}`);
      assert.ok(!res.payload.includes(SECRET_OUTSIDE), `${url} served a file outside media/`);
      assert.ok(!res.payload.includes('three_point'), `${url} served the catalog`);
      assert.ok(!res.payload.includes(dir), `${url} leaked a file system path`);
    }
  });

  test('denies dotfiles and does not list directories', async () => {
    for (const url of ['/media/.secret', '/media/.gitkeep', '/media/%2esecret', '/media/sub/../.secret']) {
      const res = await app.inject({ url });
      assert.ok([403, 404].includes(res.statusCode), `${url} -> ${res.statusCode}`);
      assert.ok(!res.payload.includes(SECRET_DOTFILE), `${url} served a dotfile`);
    }
    for (const url of ['/media/', '/media/sub', '/media/sub/', '/media']) {
      const res = await app.inject({ url });
      assert.ok([403, 404].includes(res.statusCode), `${url} -> ${res.statusCode}`);
      assert.ok(!res.payload.includes(FILE), `${url} listed the media directory`);
    }
  });

  test('serves only top-level files: nested paths 404 whether or not they exist', async () => {
    const blender = join(mediaDir, 'blender');
    await mkdir(blender, { recursive: true });
    await writeFile(join(blender, 'source.blend'), 'BLENDER-SOURCE');
    await writeFile(join(mediaDir, 'sub', FILE), usdz);
    try {
      const pairs = [
        ['/media/blender/source.blend', '/media/blender/missing.blend'],
        ['/media/blender%2Fsource.blend', '/media/blender%2Fmissing.blend'],
        [`/media/sub/${FILE}`, '/media/sub/missing-v1.usdz'],
        ['/media/blender/', '/media/missing-dir/'],
        ['/media/blender', '/media/missing-dir'],
      ];
      for (const [exists, missing] of pairs) {
        const a = await app.inject({ url: exists! });
        const b = await app.inject({ url: missing! });
        assert.equal(a.statusCode, 404, `${exists} -> ${a.statusCode}`);
        assert.equal(b.statusCode, 404, `${missing} -> ${b.statusCode}`);
        assert.ok(!a.payload.includes('BLENDER-SOURCE') && !a.rawPayload.includes(usdz.subarray(0, 64)), `${exists} served content`);
        // Same body apart from the echoed URL: nothing reveals that the nested file exists.
        assert.equal(a.payload.replace(exists!, 'X'), b.payload.replace(missing!, 'X'));
        const head = await app.inject({ method: 'HEAD', url: exists! });
        assert.equal(head.statusCode, 404, `HEAD ${exists}`);
        const range = await app.inject({ url: exists!, headers: { range: 'bytes=0-3' } });
        assert.equal(range.statusCode, 404, `Range ${exists}`);
      }
      // Top-level files, ranges and dotfiles behave as before.
      assert.equal((await app.inject({ url: `/media/${FILE}` })).statusCode, 200);
      assert.equal((await app.inject({ url: `/media/${FILE}`, headers: { range: 'bytes=0-3' } })).statusCode, 206);
      assert.equal((await app.inject({ method: 'HEAD', url: `/media/${FILE}` })).statusCode, 200);
      assert.equal((await app.inject({ url: '/media/.secret' })).statusCode, 403);
      assert.equal((await app.inject({ url: '/media/.gitkeep' })).statusCode, 403);
    } finally {
      await rm(blender, { recursive: true, force: true });
      await rm(join(mediaDir, 'sub', FILE), { force: true });
    }
  });

  test('a file the server cannot read -> 500 without the path or the immutable header', { skip: process.getuid?.() === 0 }, async () => {
    const locked = join(mediaDir, 'locked-v1.usdz');
    await writeFile(locked, usdz);
    await chmod(locked, 0o000);
    try {
      const res = await app.inject({ url: '/media/locked-v1.usdz' });
      assert.equal(res.statusCode, 500);
      assert.ok(!res.payload.includes(dir), `500 leaked a file system path: ${res.payload}`);
      assert.ok(!res.payload.includes('EACCES'), res.payload);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers.etag, undefined);
    } finally {
      await chmod(locked, 0o644);
      await rm(locked);
    }
  });
});

describe('files changing while the server runs', () => {
  test('parallel full and resumed downloads each get the exact bytes', async () => {
    const app = await buildApp({ catalogPath, mediaDir });
    try {
      const starts = Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? 0 : (i * 31) % usdz.length));
      const results = await Promise.all(
        starts.map((start) =>
          app.inject({ url: `/media/${FILE}`, headers: start ? { range: `bytes=${start}-` } : {} }),
        ),
      );
      results.forEach((res, i) => {
        const start = starts[i]!;
        assert.equal(res.statusCode, start ? 206 : 200);
        assert.ok(res.rawPayload.equals(usdz.subarray(start)), `download ${i} from byte ${start}`);
      });
    } finally {
      await app.close();
    }
  });

  test('media/ deleted and recreated: 404 while gone, served again once back', async () => {
    const media = join(dir, 'media-flaky');
    await mkdir(media);
    await writeFile(join(media, FILE), usdz);
    const app = await buildApp({ catalogPath, mediaDir: media });
    try {
      assert.equal((await app.inject({ url: `/media/${FILE}` })).statusCode, 200);
      await rm(media, { recursive: true });
      const gone = await app.inject({ url: `/media/${FILE}` });
      assert.equal(gone.statusCode, 404);
      assert.ok(!gone.payload.includes(dir));
      await mkdir(media);
      await writeFile(join(media, FILE), usdz);
      const back = await app.inject({ url: `/media/${FILE}` });
      assert.equal(back.statusCode, 200);
      assert.ok(back.rawPayload.equals(usdz));
    } finally {
      await app.close();
    }
  });

  test('catalog deleted, then replaced by rename: 500 while gone, new content once back', async () => {
    const path = join(dir, 'catalog', 'swapped.json');
    await writeFile(path, JSON.stringify([threePoint(usdz.length)]));
    const app = await buildApp({ catalogPath: path, mediaDir });
    try {
      assert.equal((await app.inject({ url: '/v1/demos' })).json().length, 1);
      await rm(path);
      const gone = await app.inject({ url: '/v1/demos' });
      assert.equal(gone.statusCode, 500);
      assert.equal(gone.json().error, 'catalog_invalid');
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify([threePoint(usdz.length), freeThrow]));
      await rename(tmp, path);
      const back = await app.inject({ url: '/v1/demos' });
      assert.equal(back.statusCode, 200);
      assert.equal(back.json().length, 2);
    } finally {
      await app.close();
    }
  });
});

describe('missing media directory', () => {
  test('the app still starts, warns, and answers 404 for media', async () => {
    const logs = captureLogs();
    const app = await buildApp({ catalogPath, mediaDir: join(dir, 'no-such-media'), logger: logs.logger });
    try {
      assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
      assert.equal((await app.inject({ url: '/v1/demos' })).statusCode, 200);
      const res = await app.inject({ url: `/media/${FILE}` });
      assert.equal(res.statusCode, 404);
      assert.ok(!res.payload.includes(dir));
      assert.ok(logs.lines.some((l) => l.level === 40 && l.msg.includes('CATALOG ASSET PROBLEM') && l.msg.includes('no such file')));
    } finally {
      await app.close();
    }
  });
});

describe('catalog asset warnings', () => {
  const warnings = (lines: { level: number; msg: string }[]) =>
    lines.filter((l) => l.level === 40 && l.msg.startsWith('CATALOG ASSET PROBLEM'));

  test('warns at startup about a stale sizeBytes, and again after a catalog edit', async () => {
    const path = join(dir, 'catalog', 'stale.json');
    await writeFile(path, JSON.stringify([threePoint(usdz.length + 1)]));
    const logs = captureLogs();
    const app = await buildApp({ catalogPath: path, mediaDir, logger: logs.logger });
    try {
      await app.ready();
      assert.equal(warnings(logs.lines).length, 1, JSON.stringify(logs.lines));
      assert.match(warnings(logs.lines)[0]!.msg, new RegExp(`sizeBytes ${usdz.length + 1} but the file is ${usdz.length} bytes`));

      // Requests against an unchanged catalog do not repeat the warning.
      await app.inject({ url: '/v1/demos' });
      assert.equal(warnings(logs.lines).length, 1);

      // Fix the size but point a second entry at a file that was never exported.
      const v2 = { ...threePoint(5), version: 2, assets: [{ format: 'usdz', sizeBytes: 5, url: '/media/three-point-follow-through-v2.usdz' }] };
      await writeFile(path, JSON.stringify([threePoint(usdz.length), v2]));
      assert.equal((await app.inject({ url: '/v1/demos' })).statusCode, 200);
      assert.equal(warnings(logs.lines).length, 2);
      assert.match(warnings(logs.lines)[1]!.msg, /three-point-follow-through v2 usdz .*no such file/);
    } finally {
      await app.close();
    }
  });

  test('warns when an export is replaced without a catalog edit, once per distinct problem', async () => {
    const media = join(dir, 'media-replaced');
    const path = join(dir, 'catalog', 'replaced.json');
    await mkdir(media);
    await writeFile(join(media, FILE), usdz);
    await writeFile(path, JSON.stringify([threePoint(usdz.length)]));
    const logs = captureLogs();
    const app = await buildApp({ catalogPath: path, mediaDir: media, logger: logs.logger });
    const demos = async () => assert.equal((await app.inject({ url: '/v1/demos' })).statusCode, 200);
    try {
      await app.ready();
      await demos();
      assert.equal(warnings(logs.lines).length, 0);

      // Someone re-exports v1 in place; the catalog is untouched.
      await writeFile(join(media, FILE), Buffer.concat([usdz, Buffer.alloc(10)]));
      await demos();
      assert.equal(warnings(logs.lines).length, 1);
      assert.match(warnings(logs.lines)[0]!.msg, new RegExp(`but the file is ${usdz.length + 10} bytes.*size_mismatch`));
      await demos();
      await demos();
      assert.equal(warnings(logs.lines).length, 1, 'the same problem is not repeated on every request');

      // A different problem, hit by many phones at once, is still logged once.
      await writeFile(join(media, FILE), Buffer.concat([usdz, Buffer.alloc(20)]));
      await Promise.all(Array.from({ length: 10 }, demos));
      assert.equal(warnings(logs.lines).length, 2);
      assert.match(warnings(logs.lines)[1]!.msg, new RegExp(`but the file is ${usdz.length + 20} bytes`));

      // Fixed, then broken the same way again: warn again.
      await writeFile(join(media, FILE), usdz);
      await demos();
      assert.equal(warnings(logs.lines).length, 2);
      await writeFile(join(media, FILE), Buffer.concat([usdz, Buffer.alloc(20)]));
      await demos();
      assert.equal(warnings(logs.lines).length, 3);

      // The export is deleted.
      await rm(join(media, FILE));
      await demos();
      assert.equal(warnings(logs.lines).length, 4);
      assert.match(warnings(logs.lines)[3]!.msg, /no such file/);
    } finally {
      await app.close();
    }
  });

  test('a correct catalog logs no warning', async () => {
    const logs = captureLogs();
    const app = await buildApp({ catalogPath, mediaDir, logger: logs.logger });
    await app.ready();
    await app.inject({ url: '/v1/demos' });
    await app.close();
    assert.deepEqual(warnings(logs.lines), []);
  });

  test('an invalid catalog at startup is logged but does not stop the server', async () => {
    const path = join(dir, 'catalog', 'invalid-at-start.json');
    await writeFile(path, '{"not": "an array"}');
    const logs = captureLogs();
    const app = await buildApp({ catalogPath: path, mediaDir, logger: logs.logger });
    try {
      await app.ready();
      assert.ok(logs.lines.some((l) => l.level === 50 && l.msg.startsWith('CATALOG INVALID')));
      assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
      assert.equal((await app.inject({ url: '/v1/demos' })).statusCode, 500);
    } finally {
      await app.close();
    }
  });
});

describe('closeWithin', () => {
  test('resolves true when the server closes in time', async () => {
    const app = await buildApp({ catalogPath, mediaDir });
    await app.ready();
    assert.equal(await closeWithin(app, 1_000), true);
  });

  test('stops waiting when close() hangs on a stalled download', async () => {
    const hung = { close: () => new Promise<undefined>(() => {}) } as Parameters<typeof closeWithin>[0];
    const t0 = Date.now();
    assert.equal(await closeWithin(hung, 50), false);
    assert.ok(Date.now() - t0 < 1_000);
  });

  test('passes a close() failure through', async () => {
    const failing = { close: () => Promise.reject(new Error('boom')) } as unknown as Parameters<typeof closeWithin>[0];
    await assert.rejects(closeWithin(failing, 1_000), /boom/);
  });
});
