import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogError, checkCatalogAssets, createCatalogReader, mediaFileName, validateCatalog } from './catalog.js';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'three-point-follow-through',
  version: 1,
  shotType: 'three_point',
  cue: 'Hold your finish until the ball reaches the rim.',
  assets: [{ format: 'usdz', sizeBytes: 761, url: '/media/three-point-follow-through-v1.usdz' }],
  ...over,
});
const withAsset = (asset: Record<string, unknown>) =>
  entry({ assets: [{ format: 'usdz', sizeBytes: 761, url: '/media/x-v1.usdz', ...asset }] });

function rejects(raw: unknown, message: RegExp) {
  assert.throws(
    () => validateCatalog(raw),
    (err: unknown) => err instanceof CatalogError && message.test(err.message),
    `expected CatalogError matching ${message}`,
  );
}

describe('validateCatalog', () => {
  test('accepts the brief example and returns only the contract fields', () => {
    const out = validateCatalog([{ ...entry(), extra: 'ignored' }]);
    assert.deepEqual(out, [entry()]);
  });

  test('accepts an absolute https URL and the same id at another version', () => {
    const out = validateCatalog([
      entry(),
      entry({ version: 2, assets: [{ format: 'usdz', sizeBytes: 9, url: 'https://cdn.example.com/a/b-v2.usdz' }] }),
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[1]!.assets[0]!.url, 'https://cdn.example.com/a/b-v2.usdz');
  });

  test('accepts an empty catalog', () => {
    assert.deepEqual(validateCatalog([]), []);
  });

  test('rejects a catalog that is not an array', () => {
    for (const raw of [null, undefined, {}, 'x', 1, { 0: entry() }]) rejects(raw, /^catalog: must be a JSON array/);
  });

  test('rejects entries that are not objects', () => {
    for (const bad of [null, 0, 'x', true]) rejects([entry(), bad], /^catalog\[1\]: must be an object/);
  });

  test('rejects unsafe or missing ids', () => {
    const ids = [undefined, 7, '', '..', '../etc', 'a/b', 'a\\b', '.hidden', '-x', '_x', 'a..b', 'a b', 'a%2Fb', 'é', 'x'.repeat(101)];
    for (const id of ids) rejects([entry({ id })], /^catalog\[0\]: id must be a safe slug/);
    assert.equal(validateCatalog([entry({ id: 'x'.repeat(100) })]).length, 1);
    assert.equal(validateCatalog([entry({ id: 'A1.b_c-d' })]).length, 1);
  });

  test('rejects versions that are not positive safe integers', () => {
    for (const version of [undefined, 0, -1, 1.5, '1', NaN, Infinity, 1e300, null]) {
      rejects([entry({ version })], /^catalog\[0\]: version must be a positive integer/);
    }
  });

  test('rejects shotTypes that are not snake_case', () => {
    for (const shotType of [undefined, '', 'Three_Point', 'three-point', 'three point', '../x', 3]) {
      rejects([entry({ shotType })], /^catalog\[0\]: shotType must be snake_case/);
    }
  });

  test('rejects empty or missing cues', () => {
    for (const cue of [undefined, '', '   \n', 5, null]) rejects([entry({ cue })], /^catalog\[0\]: cue must be a non-empty string/);
  });

  test('rejects missing or empty asset lists', () => {
    for (const assets of [undefined, [], {}, 'x', null]) rejects([entry({ assets })], /^catalog\[0\]: assets must be a non-empty array/);
  });

  test('rejects a duplicate id@version', () => {
    rejects([entry(), entry({ cue: 'other' })], /^catalog\[1\]: duplicate id\/version three-point-follow-through@1/);
  });

  test('rejects bad asset formats, including ones the phone would drop', () => {
    for (const format of [undefined, '', 'USDZ', 'usd_z', 'us dz', 'usdz/x', 1]) {
      rejects([withAsset({ format })], /^catalog\[0\]\.assets\[0\]: format must be lowercase/);
    }
    for (const bad of [null, 'usdz', 3]) rejects([entry({ assets: [bad] })], /^catalog\[0\]\.assets\[0\]: format/);
  });

  test('rejects zero, negative, fractional, string and unsafe sizes', () => {
    for (const sizeBytes of [undefined, 0, -1, 1.5, '761', NaN, Infinity, 1e300]) {
      rejects([withAsset({ sizeBytes })], /^catalog\[0\]\.assets\[0\]: sizeBytes must be a positive integer/);
    }
  });

  test('rejects URLs that are not /media/<file> or absolute https', () => {
    const urls = [
      undefined,
      7,
      '',
      'media/x.usdz', // relative without a leading slash
      'http://192.168.1.2:3001/media/x.usdz', // plain http
      'HTTP://evil.example/x.usdz',
      'ftp://evil.example/x.usdz',
      'javascript:alert(1)',
      'file:///etc/passwd',
      '//evil.example/x.usdz', // protocol-relative: resolves to a foreign host
      '/\\evil.example/x.usdz', // the URL parser treats \ as / here too
      '/media/../catalog/demos.json',
      '/media/..',
      '/media/a/../../x.usdz',
      '/media/%2e%2e/x.usdz',
      '/media/sub/x.usdz',
      '/media/.secret',
      '/media/',
      '/other/x.usdz',
      '/media/x.usdz?v=1',
      'https://',
      'https:// spaces.example/x',
    ];
    for (const url of urls) rejects([withAsset({ url })], /^catalog\[0\]\.assets\[0\]: url must be/);
  });

  test('reports the first bad entry by index', () => {
    rejects([entry(), entry({ id: 'b', version: 0 })], /^catalog\[1\]: version/);
    rejects([entry({ assets: [entry().assets[0], { format: 'usdz', sizeBytes: 1, url: 'http://x/y' }] })], /^catalog\[0\]\.assets\[1\]: url/);
  });
});

describe('mediaFileName', () => {
  test('maps only single-segment /media/ URLs to a file name', () => {
    assert.equal(mediaFileName('/media/three-point-follow-through-v1.usdz'), 'three-point-follow-through-v1.usdz');
    for (const url of ['/media/../x', '/media/.x', '/media/a/b', 'https://cdn.example.com/media/x', '/media/', '/mediax/y']) {
      assert.equal(mediaFileName(url), null, url);
    }
  });
});

describe('createCatalogReader', () => {
  let dir: string;
  let path: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'perspective-catalog-'));
    path = join(dir, 'demos.json');
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('re-reads the file only when its content changes', async () => {
    await writeFile(path, JSON.stringify([entry()]));
    const reader = createCatalogReader(path);
    const first = await reader.read();
    assert.equal(first[0]!.cue, entry().cue);
    assert.equal(await reader.read(), first, 'unchanged file returns the cached entries');

    await writeFile(path, JSON.stringify([entry({ cue: 'A longer cue that changes the file size.' })]));
    assert.equal((await reader.read())[0]!.cue, 'A longer cue that changes the file size.');
  });

  test('picks up a same-size edit made within the same mtime tick', async () => {
    const tick = 1_700_000_000; // whole seconds, so both writes get exactly the same mtime
    await writeFile(path, JSON.stringify([entry({ cue: 'Cue A' })]));
    await utimes(path, tick, tick);
    const reader = createCatalogReader(path);
    assert.equal((await reader.read())[0]!.cue, 'Cue A');
    const before = await stat(path);

    await writeFile(path, JSON.stringify([entry({ cue: 'Cue B' })]));
    await utimes(path, tick, tick);
    const after = await stat(path);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal((await reader.read())[0]!.cue, 'Cue B');
  });

  test('throws on an invalid edit and recovers when it is fixed', async () => {
    await writeFile(path, JSON.stringify([entry()]));
    const reader = createCatalogReader(path);
    await reader.read();
    await writeFile(path, JSON.stringify([entry({ version: 0 })]));
    await assert.rejects(reader.read(), CatalogError);
    await writeFile(path, '[{"id": ');
    await assert.rejects(reader.read(), SyntaxError);
    await writeFile(path, JSON.stringify([entry({ version: 3 })]));
    assert.equal((await reader.read())[0]!.version, 3);
  });

  test('throws when the file is missing', async () => {
    await assert.rejects(createCatalogReader(join(dir, 'nope.json')).read(), { code: 'ENOENT' });
  });
});

describe('checkCatalogAssets', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'perspective-assets-'));
    await mkdir(join(dir, 'media'));
    await writeFile(join(dir, 'media', 'ok-v1.usdz'), Buffer.alloc(10));
    await writeFile(join(dir, 'media', 'stale-v1.usdz'), Buffer.alloc(12));
    await mkdir(join(dir, 'media', 'dir-v1.usdz'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const asset = (url: string, sizeBytes: number) => ({ format: 'usdz', sizeBytes, url });

  test('reports missing files and stale sizeBytes, and skips https URLs', async () => {
    const entries = validateCatalog([
      entry({ id: 'ok', assets: [asset('/media/ok-v1.usdz', 10)] }),
      entry({ id: 'stale', assets: [asset('/media/stale-v1.usdz', 10)] }),
      entry({ id: 'gone', assets: [asset('/media/gone-v1.usdz', 10)] }),
      entry({ id: 'dir', assets: [asset('/media/dir-v1.usdz', 10)] }),
      entry({ id: 'cloud', assets: [asset('https://cdn.example.com/cloud-v1.usdz', 10)] }),
    ]);
    const problems = await checkCatalogAssets(entries, join(dir, 'media'));
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.match(problems[0]!, /^stale v1 usdz .*sizeBytes 10 but the file is 12 bytes.*size_mismatch/);
    assert.match(problems[1]!, /^gone v1 usdz .*no such file/);
    assert.match(problems[2]!, /^dir v1 usdz .*no such file/);
  });

  test('reports every asset when the media directory is missing, without throwing', async () => {
    const entries = validateCatalog([entry({ assets: [asset('/media/ok-v1.usdz', 10)] })]);
    const problems = await checkCatalogAssets(entries, join(dir, 'no-media'));
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /no such file/);
  });
});
