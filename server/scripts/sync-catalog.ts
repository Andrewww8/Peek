/**
 * Sets every /media/ asset's sizeBytes in demos.json from the actual export in
 * the media directory. Only sizeBytes changes: fields the server does not know
 * and key order are kept, and the file is rewritten (atomically, so a running
 * server never reads half of it) only when a size actually changed.
 */
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaFileName, validateCatalog } from '../src/catalog';

export interface SyncResult {
  /** One line per asset whose sizeBytes was updated. */
  changed: string[];
  /** One line per /media/ asset with no export file. */
  missing: string[];
}

export async function syncCatalog(catalogPath: string, mediaDir: string): Promise<SyncResult> {
  const raw: any = JSON.parse(await readFile(catalogPath, 'utf8'));
  validateCatalog(raw); // never rewrite a catalog the server would reject
  const changed: string[] = [];
  const missing: string[] = [];
  for (const e of raw) {
    for (const a of e.assets) {
      const name = mediaFileName(a.url);
      if (!name) continue; // cloud URLs are sized by whoever uploads them
      const file = join(mediaDir, name);
      const size = await stat(file).then(
        (s) => (s.isFile() ? s.size : null),
        () => null,
      );
      if (size === null) missing.push(`${e.id} v${e.version}: ${file}`);
      else if (size !== a.sizeBytes) {
        changed.push(`${e.id} v${e.version} ${a.format}: ${a.sizeBytes} -> ${size}`);
        a.sizeBytes = size;
      }
    }
  }
  if (changed.length) {
    const tmp = `${catalogPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(raw, null, 2) + '\n');
    await rename(tmp, catalogPath);
  }
  return { changed, missing };
}

if (import.meta.filename === process.argv[1]) {
  const root = join(import.meta.dirname, '..');
  const catalogPath = process.env.CATALOG_PATH ?? join(root, 'catalog', 'demos.json');
  const mediaDir = process.env.MEDIA_DIR ?? join(root, 'media');
  const { changed, missing } = await syncCatalog(catalogPath, mediaDir);
  for (const line of changed) console.log(line);
  for (const line of missing) console.error(`MISSING export for ${line}`);
  if (missing.length) process.exit(1);
  console.log('catalog sizes match exports');
}
