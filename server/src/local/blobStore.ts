/**
 * Filesystem BlobStore whose presigned URLs are served by the same Fastify app
 * (`PUT`/`GET /local-blob?token=…`). Like Vercel Blob, a presigned PUT is scoped
 * to one pathname, one content type, a byte cap and an expiry, and needs the
 * headers the presign call returned.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { BlobStore } from '../deps.js';

const SAFE_PATHNAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*\/?$/;
const TYPES: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v' };

interface Grant {
  op: 'put' | 'get';
  p: string;
  exp: number;
  max?: number;
  ct?: string;
}

class BlobHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface LocalBlobStore extends BlobStore {
  routes(app: FastifyInstance): Promise<void>;
  /** Absolute file path of a pathname (tests and the simulator inspect it). */
  fileOf(pathname: string): string;
}

export function createLocalBlobStore(root: string, signingKey: Buffer = randomBytes(32)): LocalBlobStore {
  const fileOf = (pathname: string) => {
    if (!SAFE_PATHNAME.test(pathname) || pathname.includes('..')) throw new Error(`unsafe blob pathname ${pathname}`);
    return join(root, pathname);
  };
  const sign = (body: string) => createHmac('sha256', signingKey).update(body).digest('base64url');
  const tokenFor = (g: Grant) => {
    const body = Buffer.from(JSON.stringify(g)).toString('base64url');
    return `${body}.${sign(body)}`;
  };
  function grantOf(token: string, op: Grant['op']): Grant {
    const [body, sig] = token.split('.');
    const want = body ? Buffer.from(sign(body)) : Buffer.alloc(0);
    if (!body || !sig || want.length !== Buffer.byteLength(sig) || !timingSafeEqual(want, Buffer.from(sig))) {
      throw new BlobHttpError(403, 'invalid_signature');
    }
    const g = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Grant;
    if (g.op !== op) throw new BlobHttpError(403, 'operation_not_allowed');
    if (!(Date.now() < g.exp)) throw new BlobHttpError(403, 'expired');
    return g;
  }

  return {
    fileOf,

    async presignPut({ pathname, contentType, maxBytes, expiresAt, origin }) {
      fileOf(pathname);
      return {
        url: `${origin}/local-blob?token=${tokenFor({ op: 'put', p: pathname, exp: expiresAt, max: maxBytes, ct: contentType })}`,
        headers: { 'x-vercel-blob-access': 'private', 'x-content-type': contentType, 'x-allow-overwrite': '1' },
        expiresAt,
      };
    },

    async head(pathname) {
      const s = await stat(fileOf(pathname)).catch(() => null);
      return s?.isFile() ? { sizeBytes: s.size } : null;
    },

    async read(pathname) {
      const file = fileOf(pathname);
      const s = await stat(file).catch(() => null);
      return s?.isFile() ? createReadStream(file) : null;
    },

    // The local store has no TTL sweeper; ttlDays is accepted and ignored.
    async put(pathname, body) {
      const file = fileOf(pathname);
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.part`;
      await writeFile(tmp, body);
      await rename(tmp, file);
    },

    async delete(pathname) {
      await rm(fileOf(pathname), { force: true });
    },

    async deletePrefix(prefix) {
      if (!prefix.endsWith('/')) throw new Error('prefix must end with /');
      await rm(fileOf(prefix), { recursive: true, force: true });
    },

    async signedGetUrls(pathnames, expiresAt, origin) {
      return pathnames.map((p) => {
        fileOf(p); // validates
        return `${origin}/local-blob?token=${tokenFor({ op: 'get', p, exp: expiresAt })}`;
      });
    },

    async routes(app) {
      await app.register(async (scope) => {
        // Uploads are raw bytes of any content type: hand the request stream to the handler.
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
        scope.setErrorHandler((err, _req, reply) => {
          if (err instanceof BlobHttpError) return reply.code(err.status).send({ error: err.code });
          const code = (err as { statusCode?: unknown }).statusCode;
          return reply.code(typeof code === 'number' && code >= 400 && code < 500 ? code : 500).send({ error: 'blob_error' });
        });

        scope.put<{ Querystring: { token?: string } }>('/local-blob', async (req, reply) => {
          const g = grantOf(String(req.query.token ?? ''), 'put');
          if (req.headers['x-vercel-blob-access'] !== 'private') throw new BlobHttpError(400, 'missing_access_header');
          if (req.headers['x-content-type'] !== g.ct) throw new BlobHttpError(400, 'content_type_not_allowed');
          const declared = Number(req.headers['content-length']);
          if (Number.isFinite(declared) && declared > g.max!) throw new BlobHttpError(413, 'file_too_large');
          const file = fileOf(g.p);
          await mkdir(dirname(file), { recursive: true });
          const tmp = `${file}.${randomBytes(6).toString('hex')}.part`;
          let size = 0;
          const cap = new Transform({
            transform(chunk: Buffer, _enc, done) {
              size += chunk.length;
              done(size > g.max! ? new BlobHttpError(413, 'file_too_large') : null, chunk);
            },
          });
          const body = (req.body as NodeJS.ReadableStream | undefined) ?? req.raw;
          try {
            await pipeline(body, cap, createWriteStream(tmp));
            if (size === 0) throw new BlobHttpError(400, 'empty_body');
            await rename(tmp, file);
          } catch (err) {
            await rm(tmp, { force: true });
            throw err;
          }
          return reply.send({ pathname: g.p, contentType: g.ct, size });
        });

        scope.get<{ Querystring: { token?: string } }>('/local-blob', async (req, reply) => {
          const g = grantOf(String(req.query.token ?? ''), 'get');
          const file = fileOf(g.p);
          const s = await stat(file).catch(() => null);
          if (!s?.isFile()) throw new BlobHttpError(404, 'not_found');
          const ext = g.p.split('.').pop() ?? '';
          return reply
            .header('content-type', TYPES[ext] ?? 'application/octet-stream')
            .header('content-length', s.size)
            .header('cache-control', 'private, no-store')
            .send(createReadStream(file));
        });
      });
    },
  };
}
