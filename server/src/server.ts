import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { buildApp, closeWithin } from './app';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';
const root = join(import.meta.dirname, '..');
// How long a shutdown waits for downloads in flight before cutting them off.
const SHUTDOWN_GRACE_MS = 5_000;

const app = await buildApp({
  catalogPath: process.env.CATALOG_PATH ?? join(root, 'catalog', 'demos.json'),
  mediaDir: process.env.MEDIA_DIR ?? join(root, 'media'),
  logger: true,
});

await app.listen({ port, host });

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `http://${i!.address}:${port}`);
console.log(`\nPerspective API ready. Set EXPO_PUBLIC_API_URL to one of:\n  ${lan.join('\n  ') || '(no LAN address found)'}\n`);

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
