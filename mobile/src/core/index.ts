import { createApiClient } from './apiClient';
import { ClipSync } from './clips';
import { DIRS } from './config';
import { DemoService } from './demos';
import { toDocumentUri } from './paths';
import type { Platform } from './ports';
import { initDatabase } from './schema';
import { SessionStore } from './sessions';
import { ShotStore } from './shots';
import { recoverStorage, storageUsage } from './storage';

export * from './apiClient';
export * from './clips';
export * from './config';
export * from './demos';
export * from './errors';
export * from './ports';
export * from './sessions';
export * from './shots';
export * from './stats';
export { recoverStorage, storageUsage } from './storage';

/**
 * Builds the on-device backend. Call once at app launch. Recording, tagging,
 * replay and stats never depend on the network; only the 3D demo download and
 * the clip sync use the API. Nothing here starts a sync on its own: the app
 * calls clips.syncNow() after tagging, at launch and on returning to the
 * foreground (adapters/expo.ts does this).
 */
export async function createPerspectiveBackend(
  platform: Platform,
  /** apiBaseUrl null: no API URL in this build; demo downloads and clip sync report not_configured. */
  opts: { apiBaseUrl: string | null; catalogTimeoutMs?: number },
) {
  await initDatabase(platform.db);
  await platform.files.ensureDir(toDocumentUri(platform.files, DIRS.videos));
  await platform.files.ensureDir(toDocumentUri(platform.files, DIRS.models));
  const recovery = await recoverStorage(platform);
  const api = createApiClient({ baseUrl: opts.apiBaseUrl, fetch: platform.fetch, timeoutMs: opts.catalogTimeoutMs });
  return {
    api,
    recovery,
    sessions: new SessionStore(platform),
    shots: new ShotStore(platform),
    demos: new DemoService(platform, api),
    clips: new ClipSync(platform, api),
    storageUsage: () => storageUsage(platform),
    close: () => platform.db.close(),
  };
}

export type PerspectiveBackend = Awaited<ReturnType<typeof createPerspectiveBackend>>;
