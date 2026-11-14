import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { buildUsdz, placeholderUsdz } from './make-placeholder-usdz';
import { syncCatalog } from './sync-catalog';
import { CatalogError } from '../src/catalog';

interface ZipEntry {
  name: string;
  dataOffset: number;
  data: Buffer;
}

/**
 * Minimal reader for the archive shape USDZ requires: every member stored
 * (no compression), no data descriptors, central directory consistent with the
 * local headers. Asserts as it goes and returns the members.
 */
function readStoredZip(buf: Buffer): ZipEntry[] {
  const eocdAt = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocdAt), 0x06054b50, 'end of central directory record at the end (no comment)');
  const count = buf.readUInt16LE(eocdAt + 10);
  assert.equal(buf.readUInt16LE(eocdAt + 8), count, 'entries on this disk = total entries');
  const cdSize = buf.readUInt32LE(eocdAt + 12);
  const cdOffset = buf.readUInt32LE(eocdAt + 16);
  assert.equal(cdOffset + cdSize, eocdAt, 'central directory ends where the EOCD starts');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let expectedLocal = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `central header ${i} signature`);
    const cdMethod = buf.readUInt16LE(p + 10);
    const cdCrc = buf.readUInt32LE(p + 16);
    const cdCompressed = buf.readUInt32LE(p + 20);
    const cdSize = buf.readUInt32LE(p + 24);
    const cdNameLen = buf.readUInt16LE(p + 28);
    const cdExtraLen = buf.readUInt16LE(p + 30);
    const cdCommentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const cdName = buf.toString('utf8', p + 46, p + 46 + cdNameLen);
    p += 46 + cdNameLen + cdExtraLen + cdCommentLen;

    assert.equal(localAt, expectedLocal, `${cdName}: local header offset`);
    assert.equal(buf.readUInt32LE(localAt), 0x04034b50, `${cdName}: local header signature`);
    const flags = buf.readUInt16LE(localAt + 6);
    const method = buf.readUInt16LE(localAt + 8);
    const crc = buf.readUInt32LE(localAt + 14);
    const compressed = buf.readUInt32LE(localAt + 18);
    const size = buf.readUInt32LE(localAt + 22);
    const nameLen = buf.readUInt16LE(localAt + 26);
    const extraLen = buf.readUInt16LE(localAt + 28);
    const name = buf.toString('utf8', localAt + 30, localAt + 30 + nameLen);
    const dataOffset = localAt + 30 + nameLen + extraLen;
    const data = buf.subarray(dataOffset, dataOffset + size);

    assert.equal(name, cdName, 'local and central names agree');
    assert.equal(flags & 0x08, 0, `${name}: no data descriptor`);
    assert.equal(flags & 0x01, 0, `${name}: not encrypted`);
    assert.equal(method, 0, `${name}: stored, not compressed`);
    assert.equal(cdMethod, 0);
    assert.equal(compressed, size, `${name}: stored size = size`);
    assert.equal(cdCompressed, size);
    assert.equal(cdSize, size);
    assert.equal(dataOffset % 64, 0, `${name}: file data starts on a 64-byte boundary (offset ${dataOffset})`);
    assert.equal(data.length, size, `${name}: data inside the archive`);
    assert.equal(crc, crc32(data) >>> 0, `${name}: local CRC-32 matches the data`);
    assert.equal(cdCrc, crc, `${name}: central CRC-32 matches the local one`);
    entries.push({ name, dataOffset, data });
    expectedLocal = dataOffset + size;
  }
  assert.equal(expectedLocal, cdOffset, 'local records are contiguous up to the central directory');
  assert.equal(p, eocdAt, 'central directory size matches its records');
  return entries;
}

describe('placeholder USDZ', () => {
  test('is a stored zip holding one 64-byte-aligned USDA layer with a correct CRC', () => {
    const buf = placeholderUsdz();
    const entries = readStoredZip(buf);
    assert.equal(entries.length, 1);
    const [layer] = entries;
    assert.equal(layer!.name, 'placeholder.usda');
    const text = layer!.data.toString('utf8');
    assert.ok(text.startsWith('#usda 1.0'), 'first file is a USD layer');
    assert.match(text, /defaultPrim = "Placeholder"/);
    assert.match(text, /timeSamples/, 'the placeholder is animated');
  });

  test('is deterministic, so the catalog sizeBytes stays valid across regenerations', () => {
    assert.ok(placeholderUsdz().equals(placeholderUsdz()));
  });

  test('aligns every member whatever the name lengths and data sizes', () => {
    const files = [
      { name: 'a.usda', data: Buffer.from('#usda 1.0\n') },
      { name: 'textures/some-longer-name-0123456789.png', data: Buffer.alloc(1000, 7) },
      { name: 'x', data: Buffer.alloc(0) },
      { name: 'b'.repeat(63), data: Buffer.alloc(65, 1) },
      { name: 'c'.repeat(64), data: Buffer.from('ok') },
    ];
    const entries = readStoredZip(buildUsdz(files));
    assert.deepEqual(
      entries.map((e) => e.name),
      files.map((f) => f.name),
    );
    entries.forEach((e, i) => assert.ok(e.data.equals(files[i]!.data), `${e.name} round-trips`));
  });
});

describe('syncCatalog', () => {
  let dir: string;
  let mediaDir: string;
  let catalogPath: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'perspective-sync-'));
    mediaDir = join(dir, 'media');
    catalogPath = join(dir, 'demos.json');
    await mkdir(mediaDir);
    await writeFile(join(mediaDir, 'a-v1.usdz'), Buffer.alloc(123));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const catalog = (sizeBytes: number, url = '/media/a-v1.usdz') => [
    {
      notes: 'kept by sync',
      id: 'a',
      version: 1,
      shotType: 'three_point',
      cue: 'Hold your finish.',
      assets: [
        { format: 'usdz', sizeBytes, url, exportedFrom: 'shot.blend' },
        { format: 'usdz', sizeBytes: 42, url: 'https://cdn.example.com/a-v1.usdz' },
      ],
      sport: 'basketball',
    },
  ];

  test('updates only sizeBytes and keeps unknown fields and key order', async () => {
    await writeFile(catalogPath, JSON.stringify(catalog(1), null, 2));
    const result = await syncCatalog(catalogPath, mediaDir);
    assert.deepEqual(result, { changed: ['a v1 usdz: 1 -> 123'], missing: [] });
    const text = await readFile(catalogPath, 'utf8');
    assert.equal(text, JSON.stringify(catalog(123), null, 2) + '\n');
    assert.deepEqual(Object.keys(JSON.parse(text)[0]), Object.keys(catalog(1)[0]!));
    assert.deepEqual(
      (await readdir(dir)).sort(),
      ['demos.json', 'media'],
      'no temp file left behind',
    );
  });

  test('leaves the file untouched when every size already matches', async () => {
    const original = JSON.stringify(catalog(123)); // compact on purpose: must not be reformatted
    await writeFile(catalogPath, original);
    const tick = 1_700_000_000;
    await utimes(catalogPath, tick, tick);
    const result = await syncCatalog(catalogPath, mediaDir);
    assert.deepEqual(result, { changed: [], missing: [] });
    assert.equal(await readFile(catalogPath, 'utf8'), original);
    assert.equal((await stat(catalogPath)).mtimeMs, tick * 1000);
  });

  test('reports a missing export and does not invent a size for it', async () => {
    await writeFile(catalogPath, JSON.stringify(catalog(1, '/media/gone-v1.usdz')));
    const result = await syncCatalog(catalogPath, mediaDir);
    assert.equal(result.changed.length, 0);
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0]!, /^a v1: .*gone-v1\.usdz$/);
    assert.equal(JSON.parse(await readFile(catalogPath, 'utf8'))[0].assets[0].sizeBytes, 1);
  });

  test('refuses to rewrite a catalog the server would reject', async () => {
    const bad = JSON.stringify([{ ...catalog(1)[0], version: 0 }]);
    await writeFile(catalogPath, bad);
    await assert.rejects(syncCatalog(catalogPath, mediaDir), CatalogError);
    assert.equal(await readFile(catalogPath, 'utf8'), bad);
  });
});
