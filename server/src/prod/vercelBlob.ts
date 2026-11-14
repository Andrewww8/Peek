/**
 * BlobStore on a private Vercel Blob store (@vercel/blob 2.9.0).
 *
 * Presigned PUT headers, read from node_modules/@vercel/blob/dist/chunk-*.js:
 * - `presignUrl({ operation: 'put' })` returns `https://vercel.com/api/blob/?pathname=…`
 *   with the signed `vercel-blob-*` query params (pathname scope, max size, allowed
 *   content types, expiry, overwrite, TTL), `vercel-blob-delegation` and `vercel-blob-signature`.
 * - The SDK's own presigned `put()` sends `createPutHeaders()` plus `requestApi()`'s
 *   fixed headers, and no Authorization header: `x-vercel-blob-access`,
 *   `x-content-type`, `x-allow-overwrite`, `x-api-version` (BLOB_API_VERSION = 13)
 *   and `x-vercel-blob-store-id` (parsed from the delegation token). We return
 *   exactly those. `x-api-blob-request-id`/`-attempt` are diagnostics and are omitted;
 *   `x-content-length` is only sent when VERCEL_BLOB_USE_X_CONTENT_LENGTH=1.
 * Uncertain, because no public doc covers it yet: whether the API also requires
 * `x-vercel-blob-store-id` on presigned requests (sent to match the SDK), and
 * whether `x-allow-overwrite` must repeat the signed `vercel-blob-allow-overwrite`
 * param (sent so a retried PUT of the same upload succeeds).
 */
import { Readable } from 'node:stream';
import {
  BlobNotFoundError,
  del,
  get,
  head,
  issueSignedToken,
  list,
  parseStoreIdFromDelegationToken,
  presignUrl,
  put,
} from '@vercel/blob';
import type { BlobStore } from '../deps.js';

export const BLOB_API_VERSION = '13';
export const RECORDING_TTL_DAYS = 2;

export interface VercelBlobSdk {
  issueSignedToken: typeof issueSignedToken;
  presignUrl: typeof presignUrl;
  head: typeof head;
  get: typeof get;
  put: typeof put;
  del: typeof del;
  list: typeof list;
}
const realSdk: VercelBlobSdk = { issueSignedToken, presignUrl, head, get, put, del, list };

export interface VercelBlobOptions {
  /** BLOB_READ_WRITE_TOKEN; omitted on Vercel when OIDC + BLOB_STORE_ID are used. */
  token?: string;
  sdk?: Partial<VercelBlobSdk>;
}

export function createVercelBlobStore(opts: VercelBlobOptions = {}): BlobStore {
  const sdk = { ...realSdk, ...opts.sdk };
  const auth = opts.token ? { token: opts.token } : {};
  const access = 'private' as const;

  return {
    async presignPut({ pathname, contentType, maxBytes, expiresAt }) {
      const signed = await sdk.issueSignedToken({
        ...auth,
        pathname,
        operations: ['put'],
        validUntil: expiresAt,
        maximumSizeInBytes: maxBytes,
        allowedContentTypes: [contentType],
      });
      const { presignedUrl } = await sdk.presignUrl(signed, {
        operation: 'put',
        access,
        pathname,
        validUntil: expiresAt,
        maximumSizeInBytes: maxBytes,
        allowedContentTypes: [contentType],
        allowOverwrite: true,
        // Safety net: an upload whose clips never get cut (app killed after the PUT) expires.
        ttlDays: RECORDING_TTL_DAYS,
      });
      return {
        url: presignedUrl,
        headers: {
          'x-vercel-blob-access': access,
          'x-content-type': contentType,
          'x-allow-overwrite': '1',
          'x-api-version': BLOB_API_VERSION,
          'x-vercel-blob-store-id': parseStoreIdFromDelegationToken(signed.delegationToken),
        },
        expiresAt: Math.min(expiresAt, signed.validUntil),
      };
    },

    async head(pathname) {
      try {
        const h = await sdk.head(pathname, auth);
        return { sizeBytes: h.size };
      } catch (err) {
        if (err instanceof BlobNotFoundError) return null;
        throw err;
      }
    },

    async read(pathname) {
      const r = await sdk.get(pathname, { ...auth, access, useCache: false });
      if (!r || r.statusCode !== 200) return null;
      return Readable.fromWeb(r.stream as import('node:stream/web').ReadableStream<Uint8Array>);
    },

    async put(pathname, body, contentType) {
      await sdk.put(pathname, body, { ...auth, access, contentType, allowOverwrite: true, addRandomSuffix: false });
    },

    async delete(pathname) {
      await sdk.del(pathname, auth);
    },

    async deletePrefix(prefix) {
      if (!prefix.endsWith('/')) throw new Error('prefix must end with /');
      let cursor: string | undefined;
      do {
        const page = await sdk.list({ ...auth, prefix, cursor, limit: 1000 });
        if (page.blobs.length) await sdk.del(page.blobs.map((b) => b.url), auth);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    },

    async signedGetUrls(pathnames, expiresAt) {
      // One store-wide read delegation per request; each URL's signature still binds its own pathname.
      const signed = await sdk.issueSignedToken({ ...auth, pathname: '*', operations: ['get'], validUntil: expiresAt });
      return Promise.all(
        pathnames.map(async (pathname) => (await sdk.presignUrl(signed, { operation: 'get', access, pathname, validUntil: expiresAt })).presignedUrl),
      );
    },
  };
}
