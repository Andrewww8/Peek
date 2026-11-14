/**
 * Local stand-ins for Vercel Blob, Supabase Postgres and Supabase Auth, used by
 * `npm run server` and the simulator. They enforce the same caps, scoping and
 * expiry as production. Trimming uses the real ffmpeg.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import type { Deps, Trimmer } from '../deps.js';
import { createFfmpegTrimmer } from '../ffmpeg.js';
import { SUPABASE_AUDIENCE, createJwtVerifier } from '../jwt.js';
import { createLocalBlobStore, type LocalBlobStore } from './blobStore.js';
import { createLocalClipRepo } from './clipRepo.js';

export const LOCAL_ISSUER = 'perspective-local';

export interface LocalDepsOptions {
  /** HS256 secret for local access tokens (sign them with signLocalToken). */
  jwtSecret: string;
  /** Defaults to ffmpeg-static. */
  trimmer?: Trimmer;
  /** Keep clip rows in memory only (default: persisted to <dir>/shot_clips.json). */
  inMemory?: boolean;
}

export type LocalDeps = Deps & { blob: LocalBlobStore; clips: ReturnType<typeof createLocalClipRepo> };

export function createLocalDeps(dir: string, opts: LocalDepsOptions): LocalDeps {
  mkdirSync(dir, { recursive: true });
  // Derived from the JWT secret so presigned URLs stay valid across a server restart.
  const blobKey = createHash('sha256').update(`local-blob:${opts.jwtSecret}`).digest();
  const blob = createLocalBlobStore(join(dir, 'blobs'), blobKey);
  return {
    blob,
    clips: createLocalClipRepo(opts.inMemory ? undefined : join(dir, 'shot_clips.json')),
    auth: createJwtVerifier({ hsSecret: opts.jwtSecret, issuer: LOCAL_ISSUER }),
    trimmer: opts.trimmer ?? createFfmpegTrimmer(),
    routes: (app) => blob.routes(app),
  };
}

/** A local access token shaped like a Supabase one (aud "authenticated", sub = user id). Negative ttl gives an expired token. */
export function signLocalToken(secret: string, userId: string, ttlSec = 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setAudience(SUPABASE_AUDIENCE)
    .setIssuer(LOCAL_ISSUER)
    .setIssuedAt(Math.min(now, now + ttlSec))
    .setExpirationTime(now + ttlSec)
    .sign(new TextEncoder().encode(secret));
}
