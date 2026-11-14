/**
 * Builds the app for the current environment: production deps on Vercel
 * (VERCEL=1) or when PERSPECTIVE_DEPS=production, local stand-ins otherwise.
 */
import { join } from 'node:path';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { buildApp } from './app.js';
import { createLocalDeps } from './local/index.js';
import { createProductionDeps } from './prod/index.js';

export const SERVER_ROOT = join(import.meta.dirname, '..');
export const DEFAULT_LOCAL_JWT_SECRET = 'perspective-local-dev-secret';

export function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.PERSPECTIVE_DEPS === 'production' || (env.VERCEL === '1' && env.PERSPECTIVE_DEPS !== 'local');
}

export async function buildAppFromEnv(env: NodeJS.ProcessEnv, logger: FastifyServerOptions['logger'] = true): Promise<FastifyInstance> {
  const catalogPath = env.CATALOG_PATH ?? join(SERVER_ROOT, 'catalog', 'demos.json');
  const mediaDir = env.MEDIA_DIR ?? join(SERVER_ROOT, 'media');
  if (isProduction(env)) {
    try {
      return await buildApp({ catalogPath, mediaDir, logger, deps: createProductionDeps(env) });
    } catch (err) {
      // Keep /health and /v1/demos up and make the misconfiguration visible there.
      const depsError = `clip storage is not configured: ${(err as Error).message}`;
      const app = await buildApp({ catalogPath, mediaDir, logger, depsError });
      app.log.error(depsError);
      return app;
    }
  }
  const jwtSecret = env.LOCAL_JWT_SECRET || DEFAULT_LOCAL_JWT_SECRET;
  const deps = createLocalDeps(env.LOCAL_DATA_DIR ?? join(SERVER_ROOT, '.local'), { jwtSecret });
  return buildApp({ catalogPath, mediaDir, logger, deps });
}
