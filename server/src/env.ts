/**
 * Builds the app for the current environment: production deps on Vercel
 * (VERCEL=1) or when PERSPECTIVE_DEPS=production, local stand-ins otherwise.
 */
import { join } from 'node:path';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { buildApp } from './app.js';
import { createLocalDeps } from './local/index.js';
import { createProductionDeps } from './prod/index.js';
import { anthropicModelFactory } from './coach/agent.js';

export const SERVER_ROOT = join(import.meta.dirname, '..');
export const DEFAULT_LOCAL_JWT_SECRET = 'perspective-local-dev-secret';

export function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.PERSPECTIVE_DEPS === 'production' || (env.VERCEL === '1' && env.PERSPECTIVE_DEPS !== 'local');
}

/** Local stand-ins; the coach uses the real Anthropic model only when ANTHROPIC_API_KEY is set. */
export function localDepsFromEnv(env: NodeJS.ProcessEnv) {
  return createLocalDeps(env.LOCAL_DATA_DIR ?? join(SERVER_ROOT, '.local'), {
    jwtSecret: env.LOCAL_JWT_SECRET || DEFAULT_LOCAL_JWT_SECRET,
    cvToken: env.CV_SERVICE_TOKEN || undefined,
    coachModel: env.ANTHROPIC_API_KEY ? anthropicModelFactory(env.ANTHROPIC_API_KEY) : undefined,
  });
}

/** The deps the server would use, for scripts (cv-attach, reference-ingest, reference-review). */
export function depsFromEnv(env: NodeJS.ProcessEnv) {
  return isProduction(env) ? createProductionDeps(env) : localDepsFromEnv(env);
}

export async function buildAppFromEnv(env: NodeJS.ProcessEnv, logger: FastifyServerOptions['logger'] = true): Promise<FastifyInstance> {
  const catalogPath = env.CATALOG_PATH ?? join(SERVER_ROOT, 'catalog', 'demos.json');
  const mediaDir = env.MEDIA_DIR ?? join(SERVER_ROOT, 'media');
  const options = { catalogPath, mediaDir, logger, validateCatalogOnStartup: env.VERCEL !== '1' };
  if (isProduction(env)) {
    try {
      return await buildApp({ ...options, deps: createProductionDeps(env) });
    } catch (err) {
      // Keep /health and /v1/demos up and make the misconfiguration visible there.
      const depsError = `clip storage is not configured: ${(err as Error).message}`;
      const app = await buildApp({ ...options, depsError });
      app.log.error(depsError);
      return app;
    }
  }
  return buildApp({ ...options, deps: localDepsFromEnv(env) });
}
