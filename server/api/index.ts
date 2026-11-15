/**
 * Vercel Function entry (Node.js runtime, Fluid compute): the whole Fastify app
 * behind one function. vercel.json rewrites every path here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildAppFromEnv } from '../src/env.js';

// Concurrent functions share startup. A failed cold start can be retried.
let ready: ReturnType<typeof buildAppFromEnv> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= buildAppFromEnv(process.env, true).then(async (app) => {
    await app.ready();
    return app;
  }).catch((error) => {
    ready = undefined;
    throw error;
  });
  const app = await ready;
  app.server.emit('request', req, res);
}
