import { networkInterfaces } from 'node:os';
import { closeWithin } from './app.js';
import { DEFAULT_LOCAL_JWT_SECRET, buildAppFromEnv, isProduction } from './env.js';
import { signLocalToken } from './local/index.js';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';
// How long a shutdown waits for downloads in flight before cutting them off.
const SHUTDOWN_GRACE_MS = 5_000;
/** The user that the printed local dev token signs in as. */
const LOCAL_DEV_USER = '00000000-0000-4000-8000-000000000001';

const app = await buildAppFromEnv(process.env, true);

await app.listen({ port, host });

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `http://${i!.address}:${port}`);
console.log(`\nPerspective API ready. Set EXPO_PUBLIC_API_URL to one of:\n  ${lan.join('\n  ') || '(no LAN address found)'}\n`);
if (!isProduction(process.env)) {
  const token = await signLocalToken(process.env.LOCAL_JWT_SECRET || DEFAULT_LOCAL_JWT_SECRET, LOCAL_DEV_USER, 30 * 24 * 3600);
  console.log(`Local clip storage (no Vercel/Supabase). Dev access token for user ${LOCAL_DEV_USER}, valid 30 days:\n  ${token}\n`);
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1); // a second Ctrl-C stops waiting
    stopping = true;
    closeWithin(app, SHUTDOWN_GRACE_MS).then(
      (clean) => {
        if (!clean) app.log.warn(`forced exit after ${SHUTDOWN_GRACE_MS} ms: a download was still in flight`);
        process.exit(clean ? 0 : 1);
      },
      (err) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
