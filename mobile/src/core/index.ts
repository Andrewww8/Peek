import { createApiClient } from './apiClient';
import { DIRS } from './config';
import { DemoService } from './demos';
import { toDocumentUri } from './paths';
import type { Platform } from './ports';
import { initDatabase } from './schema';
import { SessionStore } from './sessions';
import { ShotStore } from './shots';
import { recoverStorage, storageUsage } from './storage';

export * from './apiClient';
export * from './config';
export * from './demos';
export * from './errors';
export * from './ports';
export * from './sessions';
export * from './shots';
export * from './stats';
export { recoverStorage, storageUsage } from './storage';

/**
 * Builds the on-device backend. Call once at app launch. Recording, replay
 * and stats never depend on the laptop; only the 3D demo download does.
 */
export async function createPerspectiveBackend(
  platform: Platform,
  /** apiBaseUrl null: no laptop URL in this build; demo downloads fail with not_configured. */
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
    storageUsage: () => storageUsage(platform),
    close: () => platform.db.close(),
  };
}

export type PerspectiveBackend = Awaited<ReturnType<typeof createPerspectiveBackend>>;
