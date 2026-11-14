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

function webUrl(value: string, base?: URL) {
  try {
    const url = new URL(value, base);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function fetchDemoCatalog(baseUrl: string | undefined, signal: AbortSignal) {
  const base = baseUrl && webUrl(baseUrl);
  if (!base) throw new Error('Set the laptop address in EXPO_PUBLIC_API_URL to download a demo.');

  const endpoint = new URL('/v1/demos', base);
  endpoint.searchParams.set('shotType', SHOT_TYPE);
  let response: Response;
  try {
    response = await fetch(endpoint.href, { signal });
  } catch {
    throw new Error('Could not reach the demo server. Check the laptop and Wi-Fi, then retry.');
  }
  if (!response.ok) throw new Error(`The demo server returned HTTP ${response.status}.`);

  const entries: unknown = await response.json().catch(() => null);
  if (!Array.isArray(entries)) throw new Error('The demo server sent an invalid catalog.');

  const options: CatalogDemo[] = [];
  for (const entry of entries) {
    if (!object(entry) || entry.shotType !== SHOT_TYPE ||
        typeof entry.id !== 'string' || !/^[\da-z][\da-z_-]{0,79}$/i.test(entry.id) ||
        typeof entry.version !== 'number' || !Number.isSafeInteger(entry.version) || entry.version < 1 ||
        typeof entry.cue !== 'string' || !entry.cue.trim() || !Array.isArray(entry.assets)) continue;

    for (const asset of entry.assets) {
      if (!object(asset) || asset.format !== 'usdz' || typeof asset.url !== 'string' || !asset.url.trim() ||
          typeof asset.sizeBytes !== 'number' || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1) continue;

      const url = webUrl(asset.url, base);
      if (!url || (url.origin !== base.origin && url.protocol !== 'https:')) continue;

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
