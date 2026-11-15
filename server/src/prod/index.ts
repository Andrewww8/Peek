/** Production dependencies, chosen from environment variables. */
import type { Deps } from '../deps.js';
import { createFfmpegTrimmer, ffmpegPath } from '../ffmpeg.js';
import { createGuestSessionAuth } from '../guest-session.js';
import { createSupabaseVerifier } from '../jwt.js';
import { createSupabaseClient, createSupabaseClipRepo } from './supabaseRepo.js';
import { createVercelBlobStore } from './vercelBlob.js';
import { createProductionCoach, createSupabaseReferenceRepo, createSupabaseUsageRepo, missingCoachEnv } from './coach.js';
import { createPostgresGuestRateLimiter, createSupabaseGuestAccounts } from './guest-session.js';
import { createPostgresPool } from './postgres.js';
import { guestDailyLimitFromEnv, type ReferenceRepo } from '../coach/deps.js';

/** Names of the variables production needs that are missing from `env`. */
export function missingProductionEnv(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  // Vercel Blob: a read-write token, or the project's OIDC token plus the store id.
  if (!env.BLOB_READ_WRITE_TOKEN && !env.BLOB_STORE_ID) missing.push('BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID with Vercel OIDC)');
  return missing;
}

export function createProductionDeps(env: NodeJS.ProcessEnv): Deps & { references: ReferenceRepo } {
  const missing = missingProductionEnv(env);
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`);
  const guestDailyLimit = guestDailyLimitFromEnv(env.PEEK_GUEST_DAILY_LIMIT);
  const db = createSupabaseClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
  const references = createSupabaseReferenceRepo(db);
  const accountAuth = createSupabaseVerifier(env.SUPABASE_URL!, env.SUPABASE_JWT_SECRET);
  const guest = env.POSTGRES_URL ? createGuestSessionAuth({
    secret: env.PEEK_GUEST_SECRET || env.SUPABASE_SERVICE_ROLE_KEY!,
    projectOrigin: env.SUPABASE_URL!, behindVercel: env.VERCEL === '1', accountAuth,
    accounts: createSupabaseGuestAccounts(db),
    permit: createPostgresGuestRateLimiter(createPostgresPool(env.POSTGRES_URL, 1)),
  }) : undefined;
  return {
    blob: createVercelBlobStore({ token: env.BLOB_READ_WRITE_TOKEN || undefined }),
    clips: createSupabaseClipRepo(db),
    auth: guest?.auth ?? accountAuth,
    guestSessions: guest?.guestSessions,
    trimmer: createFfmpegTrimmer(ffmpegPath(env)),
    references,
    usage: createSupabaseUsageRepo(db),
    guestDailyLimit,
    // Optional: without them only the CV ingest route / the coach answer 503 not_configured; /health stays ok.
    cvToken: env.CV_SERVICE_TOKEN || undefined,
    coach: missingCoachEnv(env).length ? undefined : createProductionCoach(env, db, references),
  };
}
