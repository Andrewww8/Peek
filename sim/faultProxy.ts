/**
 * Sits between the simulated phone and the real Fastify server and injects
 * Wi-Fi-style failures: laptop off, slow link, connection dropped mid-file,
 * a download held mid-body, server errors, corrupted or rewritten catalog
 * responses.
 *
 * The mode is captured when a request arrives, so changing it later never
 * affects a request already in flight.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FaultMode =
  | { kind: 'pass' }
  | { kind: 'down' }
  | { kind: 'delay'; ms: number }
  | { kind: 'truncate_media'; fraction: number }
  /** Sends `fraction` of each media body, then holds the rest until `until` settles. */
  | { kind: 'stall_media'; fraction: number; until: Promise<unknown> }
  /** Sends the /v1/demos headers and part of its body, then holds the rest until `until` settles. */
  | { kind: 'stall_catalog_body'; until: Promise<unknown> }
  /**
   * Appends `extraBytes` to each media body, with a Content-Length that matches
   * the longer body, or (chunked) with no Content-Length at all.
   */
  | { kind: 'oversize_media'; extraBytes: number; chunked?: boolean }
  /** Rewrites relative asset URLs in /v1/demos to absolute http URLs on the proxy's own origin. */
  | { kind: 'absolute_http_catalog' }
  /** Holds every request whose "METHOD /path" matches, before forwarding it, until `until` settles. Others pass. */
  | { kind: 'stall_requests'; match: RegExp; until: Promise<unknown> }
  /** For a matching "METHOD /path": send the headers and the first `afterBytes` of the body, then hold the rest until `until` settles. */
  | { kind: 'stall_response'; match: RegExp; afterBytes: number; until: Promise<unknown> }
  | { kind: 'http500' }
  | { kind: 'garbage_catalog' };

export interface FaultProxy {
  url: string;
  mode: FaultMode;
  /**
   * Re-chunk text/event-stream bodies into 1-7 byte writes with an event-loop
   * turn between them (on by default), so SSE events reach the phone split at
   * arbitrary points, as on a real mobile network.
   */
  splitSse: boolean;
  counters: {
    requests: number;
    mediaRequests: number;
    dropped: number;
    /** Recording PUTs to the presigned blob URL. */
    uploads: number;
    /** POST /v1/recordings/:id/clips. */
    clipCuts: number;
    /** Any request to the authenticated clip API or the blob URLs. */
    cloudCalls: number;
  };
  close(): Promise<void>;
}

export async function startFaultProxy(upstreamPort: number): Promise<FaultProxy> {
  const proxy: FaultProxy = {
    url: '',
    mode: { kind: 'pass' },
    splitSse: true,
    counters: { requests: 0, mediaRequests: 0, dropped: 0, uploads: 0, clipCuts: 0, cloudCalls: 0 },
    close: async () => undefined,
  };

  let seed = 12345;
  const server: Server = createServer((req, res) => {
    proxy.counters.requests++;
    const isMedia = req.url?.startsWith('/media/') ?? false;
    const isCatalog = req.url?.startsWith('/v1/demos') ?? false;
    if (isMedia) proxy.counters.mediaRequests++;
    const url = req.url ?? '';
    if (/^\/(v1\/(recordings|sessions|clips)|local-blob)/.test(url)) proxy.counters.cloudCalls++;
    if (req.method === 'PUT' && url.startsWith('/local-blob')) proxy.counters.uploads++;
    if (req.method === 'POST' && /^\/v1\/recordings\/[^/]+\/clips/.test(url)) proxy.counters.clipCuts++;
    const mode = proxy.mode;

    if (mode.kind === 'down') {
      proxy.counters.dropped++;
      req.socket.destroy();
      return;
    }
    if (mode.kind === 'http500') {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
      return;
    }
    if (mode.kind === 'garbage_catalog' && isCatalog) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"not": "an array"');
      return;
    }

    const forward = () => {
      if (res.destroyed) return;
      const up = request(
        { host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: req.headers },
        (upRes) => {
          if (mode.kind === 'absolute_http_catalog' && isCatalog) {
            const chunks: Buffer[] = [];
            upRes.on('data', (c: Buffer) => chunks.push(c));
            upRes.on('end', () => {
              let body = Buffer.concat(chunks).toString('utf8');
              if (upRes.statusCode === 200) {
                const entries = JSON.parse(body) as { assets?: { url?: string }[] }[];
                for (const e of entries) {
                  for (const a of e.assets ?? []) if (a.url?.startsWith('/')) a.url = proxy.url + a.url;
                }
                body = JSON.stringify(entries);
              }
              const headers = { ...upRes.headers, 'content-length': String(Buffer.byteLength(body)) };
              res.writeHead(upRes.statusCode ?? 502, headers).end(body);
            });
            return;
          }

          if (mode.kind === 'stall_catalog_body' && isCatalog) {
            const chunks: Buffer[] = [];
            upRes.on('data', (c: Buffer) => chunks.push(c));
            upRes.on('end', () => {
              const body = Buffer.concat(chunks);
              const cut = Math.max(1, Math.floor(body.length / 2));
              res.writeHead(upRes.statusCode ?? 502, upRes.headers);
              res.write(body.subarray(0, cut));
              void Promise.resolve(mode.until)
                .catch(() => undefined)
                .then(() => !res.destroyed && res.end(body.subarray(cut)));
            });
            return;
          }

          if (mode.kind === 'oversize_media' && isMedia && upRes.statusCode === 200) {
            const length = Number(upRes.headers['content-length'] ?? 0) + mode.extraBytes;
            const headers = { ...upRes.headers, 'content-length': String(length) };
            if (mode.chunked) delete (headers as Record<string, unknown>)['content-length'];
            res.writeHead(200, headers);
            upRes.on('data', (c: Buffer) => !res.destroyed && res.write(c));
            upRes.on('end', () => {
              // Stream the extra in 64 KiB pieces, honouring backpressure, until the phone stops reading.
              let left = mode.extraBytes;
              const pump = () => {
                while (left > 0 && !res.destroyed) {
                  const n = Math.min(left, 65_536);
                  left -= n;
                  if (!res.write(Buffer.alloc(n, 0x5a))) return void res.once('drain', pump);
                }
                if (!res.destroyed) res.end();
              };
              pump();
            });
            return;
          }

          const isSse = String(upRes.headers['content-type'] ?? '').startsWith('text/event-stream');
          if (mode.kind === 'stall_response' && mode.match.test(`${req.method} ${url}`)) {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            res.flushHeaders();
            let sent = 0;
            let released = false;
            let ended = false;
            const held: Buffer[] = [];
            const write = (c: Buffer) => !res.destroyed && c.length > 0 && res.write(c);
            upRes.on('data', (chunk: Buffer) => {
              if (released) return void write(chunk);
              const head = chunk.subarray(0, Math.max(0, mode.afterBytes - sent));
              write(head);
              sent += head.length;
              if (head.length < chunk.length) held.push(chunk.subarray(head.length));
            });
            upRes.on('end', () => {
              ended = true;
              if (released && !res.destroyed) res.end();
            });
            void Promise.resolve(mode.until)
              .catch(() => undefined)
              .then(() => {
                released = true;
                for (const c of held.splice(0)) write(c);
                if (ended && !res.destroyed) res.end();
              });
            return;
          }
          if (isSse && proxy.splitSse) {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            res.flushHeaders();
            const queue: Buffer[] = [];
            let ended = false;
            let pumping = false;
            const pump = () => {
              if (res.destroyed) return;
              const c = queue[0];
              if (!c) {
                pumping = false;
                if (ended) res.end();
                return;
              }
              seed = (seed * 1103515245 + 12345) & 0x7fffffff;
              const n = 1 + (seed % 7);
              res.write(c.subarray(0, n));
              if (n >= c.length) queue.shift();
              else queue[0] = c.subarray(n);
              setImmediate(pump);
            };
            upRes.on('data', (chunk: Buffer) => {
              queue.push(chunk);
              if (!pumping) {
                pumping = true;
                setImmediate(pump);
              }
            });
            upRes.on('end', () => {
              ended = true;
              if (!pumping && !res.destroyed) res.end();
            });
            return;
          }

          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          if (mode.kind === 'truncate_media' && isMedia) {
            const total = Number(upRes.headers['content-length'] ?? 0);
            const limit = Math.max(1, Math.floor(total * mode.fraction));
            let sent = 0;
            upRes.on('data', (chunk: Buffer) => {
              if (sent >= limit) return;
              const slice = chunk.subarray(0, limit - sent);
              sent += slice.length;
              res.write(slice);
              if (sent >= limit) {
                proxy.counters.dropped++;
                upRes.destroy();
                res.socket?.destroy();
              }
            });
            upRes.on('end', () => res.end());
          } else if (mode.kind === 'stall_media' && isMedia) {
            const total = Number(upRes.headers['content-length'] ?? 0);
            const limit = Math.max(1, Math.floor(total * mode.fraction));
            const held: Buffer[] = [];
            let sent = 0;
            let released = false;
            let ended = false;
            const write = (c: Buffer) => {
              if (!res.destroyed && c.length) res.write(c);
            };
            upRes.on('data', (chunk: Buffer) => {
              if (released) return write(chunk);
              const head = chunk.subarray(0, Math.max(0, limit - sent));
              write(head);
              sent += head.length;
              if (head.length < chunk.length) held.push(chunk.subarray(head.length));
            });
            upRes.on('end', () => {
              ended = true;
              if (released && !res.destroyed) res.end();
            });
            void Promise.resolve(mode.until)
              .catch(() => undefined)
              .then(() => {
                released = true;
                for (const c of held.splice(0)) write(c);
                if (ended && !res.destroyed) res.end();
              });
          } else {
            upRes.pipe(res);
          }
        },
      );
      // Track disconnects before upstream sends headers as well as mid-body.
      res.once('close', () => {
        if (!res.writableFinished) up.destroy();
      });
      up.on('error', () => res.socket?.destroy());
      req.pipe(up);
    };

    if (mode.kind === 'delay') setTimeout(forward, mode.ms);
    else if (mode.kind === 'stall_requests' && mode.match.test(`${req.method} ${url}`)) {
      void Promise.resolve(mode.until)
        .catch(() => undefined)
        .then(() => !req.socket.destroyed && forward());
    } else forward();
  });
  server.keepAliveTimeout = 1;

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  proxy.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  proxy.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return proxy;
}
