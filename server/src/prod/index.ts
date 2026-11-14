/** Production dependencies, chosen from environment variables. */
import type { Deps } from '../deps.js';
import { createFfmpegTrimmer, ffmpegPath } from '../ffmpeg.js';
import { createSupabaseVerifier } from '../jwt.js';
import { createSupabaseClient, createSupabaseClipRepo } from './supabaseRepo.js';
import { createVercelBlobStore } from './vercelBlob.js';

/** Names of the variables production needs that are missing from `env`. */
export function missingProductionEnv(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  // Vercel Blob: a read-write token, or the project's OIDC token plus the store id.
  if (!env.BLOB_READ_WRITE_TOKEN && !env.BLOB_STORE_ID) missing.push('BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID with Vercel OIDC)');
  return missing;
}

export function createProductionDeps(env: NodeJS.ProcessEnv): Deps {
  const missing = missingProductionEnv(env);
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`);
  return {
    blob: createVercelBlobStore({ token: env.BLOB_READ_WRITE_TOKEN || undefined }),
    clips: createSupabaseClipRepo(createSupabaseClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!)),
    auth: createSupabaseVerifier(env.SUPABASE_URL!, env.SUPABASE_JWT_SECRET),
    trimmer: createFfmpegTrimmer(ffmpegPath(env)),
  };
}
