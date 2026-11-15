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
import { MemorySaver } from '@langchain/langgraph';
import { COACH_DAILY_LIMIT, COACH_MODEL, COACH_RECURSION_LIMIT, type CoachDeps } from '../coach/deps.js';
import { createLocalReferenceRepo, createLocalUsageRepo } from './coachRepos.js';

export const LOCAL_ISSUER = 'perspective-local';

export interface LocalDepsOptions {
  /** HS256 secret for local access tokens (sign them with signLocalToken). */
  jwtSecret: string;
  /** Defaults to ffmpeg-static. */
  trimmer?: Trimmer;
  /** Keep clip rows in memory only (default: persisted to <dir>/shot_clips.json). */
  inMemory?: boolean;
  /** Bearer token for POST /v1/internal/analysis (default: LOCAL_CV_TOKEN). */
  cvToken?: string;
  /**
   * The coach's model. Tests and the simulator pass a factory returning LangChain's fake
   * tool-calling model (`fakeModel()` from @langchain/core/testing), so nothing calls the network.
   * Omitted: the coach answers 503 not_configured.
   */
  coachModel?: CoachDeps['createModel'];
  coachDailyLimit?: number;
  coachRecursionLimit?: number;
  coachKeepAliveMs?: number;
  /** Fixed "today" for the daily cap (tests). */
  today?: () => string;
}

export const LOCAL_CV_TOKEN = 'perspective-local-cv-token';

export type LocalDeps = Deps & {
  blob: LocalBlobStore;
  clips: ReturnType<typeof createLocalClipRepo>;
  references: ReturnType<typeof createLocalReferenceRepo>;
  usage: ReturnType<typeof createLocalUsageRepo>;
};

export function createLocalDeps(dir: string, opts: LocalDepsOptions): LocalDeps {
  mkdirSync(dir, { recursive: true });
  // Derived from the JWT secret so presigned URLs stay valid across a server restart.
  const blobKey = createHash('sha256').update(`local-blob:${opts.jwtSecret}`).digest();
  const blob = createLocalBlobStore(join(dir, 'blobs'), blobKey);
  const references = createLocalReferenceRepo(opts.inMemory ? undefined : join(dir, 'reference.json'));
  const usage = createLocalUsageRepo(opts.inMemory ? undefined : join(dir, 'coach_usage.json'));
  const coach: CoachDeps | undefined = opts.coachModel && {
    createModel: opts.coachModel,
    modelName: COACH_MODEL,
    checkpointer: new MemorySaver(),
    usage,
    references,
    dailyLimit: opts.coachDailyLimit ?? COACH_DAILY_LIMIT,
    recursionLimit: opts.coachRecursionLimit ?? COACH_RECURSION_LIMIT,
    keepAliveMs: opts.coachKeepAliveMs,
    today: opts.today,
  };
  return {
    references,
    usage,
    coach,
    cvToken: opts.cvToken ?? LOCAL_CV_TOKEN,
    blob,
    clips: createLocalClipRepo(opts.inMemory ? undefined : join(dir, 'shot_clips.json')),
    auth: createJwtVerifier({ hsSecret: opts.jwtSecret, issuer: LOCAL_ISSUER }),
    trimmer: opts.trimmer ?? createFfmpegTrimmer(),
    routes: (app) => blob.routes(app),
  };
}

/** A local access token shaped like a Supabase one (aud "authenticated", sub = user id). Negative ttl gives an expired token. */
export function signLocalToken(secret: string, userId: string, ttlSec = 3600, isGuest = false): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: 'authenticated', is_anonymous: isGuest })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setAudience(SUPABASE_AUDIENCE)
    .setIssuer(LOCAL_ISSUER)
    .setIssuedAt(Math.min(now, now + ttlSec))
    .setExpirationTime(now + ttlSec)
    .sign(new TextEncoder().encode(secret));
}
