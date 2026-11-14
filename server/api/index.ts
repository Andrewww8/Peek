/**
 * Vercel Function entry (Node.js runtime, Fluid compute): the whole Fastify app
 * behind one function. vercel.json rewrites every path here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildAppFromEnv } from '../src/env.js';

// Built once per instance and reused across invocations.
const ready = buildAppFromEnv(process.env, true).then(async (app) => {
  await app.ready();
  return app;
});

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await ready;
  app.server.emit('request', req, res);
}
