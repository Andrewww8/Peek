import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DemoAsset {
  format: string;
  sizeBytes: number;
  url: string;
}

export interface DemoEntry {
  id: string;
  version: number;
  shotType: string;
  cue: string;
  assets: DemoAsset[];
}

export class CatalogError extends Error {}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// The phone names the model file `${id}-v${version}.${format}`; keep that well under 255 bytes.
const MAX_ID_LENGTH = 100;
const SAFE_TOKEN = /^[a-z0-9_]+$/;
// Same rule as the phone, which silently drops assets with any other format.
const FORMAT = /^[a-z0-9]+$/;
// The only relative URLs this server can answer: one versioned file directly under /media/.
const MEDIA_URL = /^\/media\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

function fail(where: string, msg: string): never {
  throw new CatalogError(`${where}: ${msg}`);
}

/** File name inside the media directory for a relative `/media/<file>` URL, or null for any other URL. */
export function mediaFileName(url: string): string | null {
  const name = MEDIA_URL.exec(url)?.[1];
  return name && !name.includes('..') ? name : null;
}

function isHttpsUrl(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  try {
    return new URL(url).hostname !== '';
  } catch {
    return false;
  }
}

/** Validates the raw demos.json content. Throws CatalogError describing the first problem. */
export function validateCatalog(raw: unknown): DemoEntry[] {
  if (!Array.isArray(raw)) fail('catalog', 'must be a JSON array');
  const seen = new Set<string>();
  return raw.map((e: any, i): DemoEntry => {
    const at = `catalog[${i}]`;
    if (!e || typeof e !== 'object') fail(at, 'must be an object');
    if (typeof e.id !== 'string' || !SAFE_ID.test(e.id) || e.id.includes('..') || e.id.length > MAX_ID_LENGTH) {
      fail(at, 'id must be a safe slug');
    }
    if (!Number.isSafeInteger(e.version) || e.version < 1) fail(at, 'version must be a positive integer');
    if (typeof e.shotType !== 'string' || !SAFE_TOKEN.test(e.shotType)) fail(at, 'shotType must be snake_case');
    if (typeof e.cue !== 'string' || e.cue.trim() === '') fail(at, 'cue must be a non-empty string');
    if (!Array.isArray(e.assets) || e.assets.length === 0) fail(at, 'assets must be a non-empty array');
    const key = `${e.id}@${e.version}`;
    if (seen.has(key)) fail(at, `duplicate id/version ${key}`);
    seen.add(key);
    const assets = e.assets.map((a: any, j: number): DemoAsset => {
      const aat = `${at}.assets[${j}]`;
      if (typeof a?.format !== 'string' || !FORMAT.test(a.format)) fail(aat, 'format must be lowercase letters and digits');
      if (!Number.isSafeInteger(a.sizeBytes) || a.sizeBytes <= 0) fail(aat, 'sizeBytes must be a positive integer');
      if (typeof a.url !== 'string' || !(mediaFileName(a.url) || isHttpsUrl(a.url))) {
        fail(aat, 'url must be /media/<file> or an absolute https URL');
      }
      return { format: a.format, sizeBytes: a.sizeBytes, url: a.url };
    });
    return { id: e.id, version: e.version, shotType: e.shotType, cue: e.cue, assets };
  });
}

/**
 * Reads demos.json on every call and re-validates it only when its content
 * changes, so the team can edit the catalog without restarting the server.
 * Comparing content rather than mtime and size also catches a same-size edit
 * made within one file-system timestamp tick. The file is a few hundred bytes.
 */
export function createCatalogReader(path: string) {
  let cache: { text: string; entries: DemoEntry[] } | null = null;
  return {
    async read(): Promise<DemoEntry[]> {
      const text = await readFile(path, 'utf8');
      if (cache && cache.text === text) return cache.entries;
      const entries = validateCatalog(JSON.parse(text));
      cache = { text, entries };
      return entries;
    },
  };
}

/**
 * Checks every `/media/` asset against the file the server will send. Returns
 * one message per asset a phone would reject: a missing file (404) or a
 * `sizeBytes` that differs from the file (size_mismatch). Never throws.
 */
export async function checkCatalogAssets(entries: DemoEntry[], mediaDir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const e of entries) {
    for (const a of e.assets) {
      const name = mediaFileName(a.url);
      if (!name) continue; // cloud URLs are sized by whoever uploads them
      const where = `${e.id} v${e.version} ${a.format} (${a.url})`;
      const size = await stat(join(mediaDir, name)).then(
        (s) => (s.isFile() ? s.size : null),
        () => null,
      );
      if (size === null) problems.push(`${where}: no such file in the media directory, phones will get 404`);
      else if (size !== a.sizeBytes) {
        problems.push(`${where}: catalog sizeBytes ${a.sizeBytes} but the file is ${size} bytes, phones will reject it as size_mismatch`);
      }
    }
  }
  return problems;
}
