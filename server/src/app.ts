import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { CatalogError, checkCatalogAssets, createCatalogReader, mediaFileName, type DemoEntry } from './catalog.js';
import { analysisRoutes } from './analysis.js';
import { clipRoutes } from './clips.js';
import type { Deps } from './deps.js';
import { registerGuestSessionRoute } from './guest-session.js';

export interface AppOptions {
  /** Path to demos.json. */
  catalogPath: string;
  /** Directory containing only the mobile exports (never Blender sources). */
  mediaDir: string;
  /** `true` for the default logger; tests pass an options object with their own stream. */
  logger?: FastifyServerOptions['logger'];
  /** The Vercel handler verifies catalog assets when serving the catalog. */
  validateCatalogOnStartup?: boolean;
  /** Blob store, clip repo, auth and trimmer for the authenticated clip API. */
  deps?: Deps;
  /**
   * Set when production deps could not be built (missing env vars). /health then
   * answers 503 with this message, and the clip API answers 503 not_configured.
   */
  depsError?: string;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const mediaDir = resolve(opts.mediaDir);
  const catalog = createCatalogReader(resolve(opts.catalogPath));

  // On every catalog read (startup and each /v1/demos request), check the /media/ assets
  // against their files: one stat per asset. A stale sizeBytes then shows up on the laptop,
  // whether the catalog was edited or an export was replaced, instead of as a rejected
  // download on the phone. Each distinct problem is logged once, and again only if it
  // goes away and comes back.
  let reported = new Set<string>();
  async function readCatalog(): Promise<DemoEntry[]> {
    const entries = await catalog.read();
    const problems = await checkCatalogAssets(entries, mediaDir);
    // No await between here and the assignment, so concurrent requests cannot log a problem twice.
    for (const problem of problems) {
      if (!reported.has(problem)) {
        app.log.warn(`CATALOG ASSET PROBLEM ${problem}. Fix the export or run: npm run sync-catalog -w server`);
      }
    }
    reported = new Set(problems);
    return entries;
  }

  if (opts.validateCatalogOnStartup !== false) {
    app.addHook('onReady', async () => {
      try {
        await readCatalog();
      } catch (err) {
        app.log.error({ err }, 'CATALOG INVALID: /v1/demos answers 500 until demos.json is fixed');
      }
    });
  }

  // 5xx errors (e.g. EACCES on a media file) carry the laptop's absolute file path. Log them, never send them.
  app.setErrorHandler((err, req, reply) => {
    const code = (err as { statusCode?: unknown } | null)?.statusCode;
    const status = typeof code === 'number' && code >= 400 && code < 600 ? code : 500;
    if (status < 500) return reply.send(err); // Fastify's default 4xx body
    req.log.error({ err }, 'request failed');
    reply.removeHeader('etag').removeHeader('last-modified').header('cache-control', 'no-store');
    return reply.code(status).send({ statusCode: status, error: 'Internal Server Error', message: 'internal error' });
  });

  app.get('/health', async (_req, reply) => {
    const time = new Date().toISOString();
    if (opts.depsError) return reply.code(503).send({ status: 'error', service: 'perspective-api', time, message: opts.depsError });
    return { status: 'ok', service: 'perspective-api', time };
  });

  registerGuestSessionRoute(app, opts.deps?.guestSessions);
  await app.register(clipRoutes, { deps: opts.deps, depsError: opts.depsError });
  await app.register(analysisRoutes, { blob: opts.deps?.blob, clips: opts.deps?.clips, cvToken: opts.deps?.cvToken });
  if (opts.deps?.routes) await opts.deps.routes(app);

  app.get<{ Querystring: { shotType?: string } }>(
    '/v1/demos',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { shotType: { type: 'string', pattern: '^[a-z0-9_]+$', maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const entries = await readCatalog();
        const { shotType } = req.query;
        return shotType ? entries.filter((e) => e.shotType === shotType) : entries;
      } catch (err) {
        req.log.error({ err }, 'catalog unreadable');
        const message = err instanceof CatalogError ? err.message : 'catalog unreadable';
        return reply.code(500).send({ error: 'catalog_invalid', message });
      }
    },
  );

  await app.register(fastifyStatic, {
    root: mediaDir,
    prefix: '/media/',
    index: false,
    list: false,
    dotfiles: 'deny',
    // Serve only what a catalog URL can name: one safe file directly in media/. Anything nested
    // (e.g. a Blender source folder dropped in by mistake) gets the same 404 whether it exists
    // or not, because this runs before the file is looked up. Top-level dot names still go to
    // send, which denies them with 403 as before.
    allowedPath: (pathname) => mediaFileName(`/media${pathname}`) !== null || /^\/\.[^/\\]*$/.test(pathname),
    // Versioned filenames never change content, so phones and proxies may cache them forever.
    // These go through send's own Cache-Control header; a setHeaders value would be overwritten by it.
    cacheControl: true,
    maxAge: '365d',
    immutable: true,
  });

  return app;
}

/**
 * Closes the server but stops waiting after `timeoutMs`. A phone that stalls
 * mid-download (asleep, out of Wi-Fi range) otherwise keeps `close()` pending
 * forever and the port stays bound. Resolves true when the close finished in time.
 */
export async function closeWithin(app: Pick<FastifyInstance, 'close'>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), timeoutMs);
  });
  try {
    return await Promise.race([app.close().then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
