import { apiOrigin, httpsUrl } from './api.ts';
import { SHOT_TYPE, STORAGE_RESERVE_BYTES } from './practice.ts';
import type { SavedDemo } from './database.ts';

export type CatalogDemo = Pick<SavedDemo, 'id' | 'version' | 'shotType' | 'cue' | 'sizeBytes'> & {
  url: string;
};

export type DemoFiles = {
  size(path: string): number;
  availableBytes(): number;
  stage(callback: (temporaryPath: string, destinationPath: string) => Promise<void>): Promise<void>;
  download(url: string, path: string, onBytes: (bytes: number) => void, signal: AbortSignal): Promise<void>;
  move(source: string, destination: string): void;
  remove(path: string): void;
};

type DemoStore = {
  listDemos(): SavedDemo[];
  saveDemo(demo: SavedDemo): void;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function fetchDemoCatalog(baseUrl: string, signal: AbortSignal, request = fetch) {
  const base = apiOrigin(baseUrl);
  const endpoint = new URL('/v1/demos', base);
  endpoint.searchParams.set('shotType', SHOT_TYPE);
  let response: Response;
  try {
    response = await request(endpoint.href, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
  } catch {
    if (signal.aborted) throw new Error('The demo request timed out. Try again.');
    throw new Error('Could not reach the demo server. Check your connection and try again.');
  }
  if (response.status === 503) throw new Error('The demo service is temporarily unavailable. Try again shortly.');
  if (!response.ok) throw new Error(`The demo server returned HTTP ${response.status}.`);

  const entries: unknown = await response.json().catch(() => null);
  if (signal.aborted) throw new Error('The demo request timed out. Try again.');
  if (!Array.isArray(entries)) throw new Error('The demo server sent an invalid catalog.');

  const options: CatalogDemo[] = [];
  for (const entry of entries) {
    if (!object(entry) || entry.shotType !== SHOT_TYPE ||
        typeof entry.id !== 'string' || !/^[\da-z][\da-z._-]{0,99}$/i.test(entry.id) || entry.id.includes('..') ||
        typeof entry.version !== 'number' || !Number.isSafeInteger(entry.version) || entry.version < 1 ||
        typeof entry.cue !== 'string' || !entry.cue.trim() || !Array.isArray(entry.assets)) continue;

    for (const asset of entry.assets) {
      if (!object(asset) || asset.format !== 'usdz' || typeof asset.url !== 'string' || !asset.url.trim() ||
          typeof asset.sizeBytes !== 'number' || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1) continue;

      const url = httpsUrl(asset.url, base);
      if (!url) continue;

      options.push({
        id: entry.id, version: entry.version, shotType: SHOT_TYPE, cue: entry.cue.trim(),
        url: url.href, sizeBytes: asset.sizeBytes,
      });
      break;
    }
  }
  return options.sort((left, right) => right.version - left.version || left.id.localeCompare(right.id));
}

export function cachedDemo(store: DemoStore, files: Pick<DemoFiles, 'size'>) {
  return store.listDemos().find((demo) => files.size(demo.localPath) === demo.sizeBytes) ?? null;
}

export async function downloadDemo(
  demo: CatalogDemo,
  store: DemoStore,
  files: DemoFiles,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) {
  if (files.availableBytes() - STORAGE_RESERVE_BYTES < demo.sizeBytes) {
    throw new Error('Free some device storage and retry the download.');
  }

  let saved: SavedDemo | undefined;
  await files.stage(async (temporary, destination) => {
    let promoted = false;
    try {
      if (signal.aborted) throw new Error('The download was interrupted.');
      await files.download(demo.url, temporary, (bytes) => {
        onProgress(Math.min(1, Math.max(0, bytes / demo.sizeBytes)));
      }, signal);
      if (signal.aborted) throw new Error('The download was interrupted.');
      if (files.size(temporary) !== demo.sizeBytes) {
        throw new Error('The downloaded file size did not match the catalog. Try again.');
      }

      files.move(temporary, destination);
      promoted = true;
      const row: SavedDemo = {
        id: demo.id, version: demo.version, format: 'usdz', shotType: demo.shotType,
        localPath: destination, cue: demo.cue, sizeBytes: demo.sizeBytes,
      };
      const replaced = store.listDemos().find(({ id, version }) => id === row.id && version === row.version);
      store.saveDemo(row);
      saved = row;

      if (replaced && replaced.localPath !== row.localPath) removePartial(files, replaced.localPath);
    } finally {
      removePartial(files, temporary);
      if (promoted && !saved) removePartial(files, destination);
    }
  });
  if (!saved) throw new Error('The download could not be saved.');
  return saved;
}

function removePartial(files: DemoFiles, path: string) {
  try {
    files.remove(path);
  } catch {
    // Cleanup must not hide the result of a download or invalidate the saved version.
  }
}
