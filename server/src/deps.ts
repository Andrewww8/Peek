/**
 * The four services the shot-clip API depends on. Production uses Vercel Blob,
 * Supabase Postgres, Supabase Auth and ffmpeg-static (src/prod/); local
 * development and the simulator use src/local/, which enforces the same limits.
 */
import type { Readable } from 'node:stream';

/** Recording upload limits from PROJECT_CONTEXT.md. */
export const MAX_RECORDING_BYTES = 60 * 1024 * 1024;
export const MAX_RECORDING_DURATION_MS = 30_000;
/** Probed durations may exceed the declared one by container rounding. */
export const DURATION_TOLERANCE_MS = 500;
/** Clip window around a release. */
export const CLIP_BEFORE_MS = 3_000;
export const CLIP_AFTER_MS = 1_000;
export const UPLOAD_URL_TTL_MS = 15 * 60_000;
export const SIGNED_GET_TTL_MS = 15 * 60_000;
/** Shot clips are temporary inputs to analysis; Blob deletes them after this many days if CV never runs. */
export const CLIP_TTL_DAYS = 7;
export const CLIP_TTL_MS = CLIP_TTL_DAYS * 24 * 3600_000;
/** Largest CV npz the API reads for one shot clip. */
export const MAX_NPZ_BYTES = 64 * 1024 * 1024;
/** A single-player worker result fits in a small JSON body on Vercel. */
export const MAX_INLINE_NPZ_BYTES = 512 * 1024;
export const MAX_SHOTS_PER_REQUEST = 200;

export const RECORDING_TYPES: Record<string, string> = { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v' };
export const OUTCOMES = ['made', 'missed', 'unmarked'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PresignedPut {
  url: string;
  /** Every header the PUT must send, exactly as given. */
  headers: Record<string, string>;
  /** ms since epoch. */
  expiresAt: number;
}

export interface BlobStore {
  /** Presigned PUT for exactly one private pathname. `origin` is the API origin of this request (used by the local store). */
  presignPut(opts: { pathname: string; contentType: string; maxBytes: number; expiresAt: number; origin: string }): Promise<PresignedPut>;
  /** Size in bytes, or null when the blob does not exist. */
  head(pathname: string): Promise<{ sizeBytes: number } | null>;
  /** The blob's content, or null when it does not exist. */
  read(pathname: string): Promise<Readable | null>;
  put(pathname: string, body: Buffer, contentType: string, opts?: { ttlDays?: number }): Promise<void>;
  /** Idempotent: deleting a missing blob succeeds. */
  delete(pathname: string): Promise<void>;
  /** Deletes every blob whose pathname starts with `prefix` (which must end in `/`). */
  deletePrefix(prefix: string): Promise<void>;
  /** Short-lived GET URLs, in the same order as `pathnames`. */
  signedGetUrls(pathnames: string[], expiresAt: number, origin: string): Promise<string[]>;
}

export interface ClipRow {
  userId: string;
  sessionId: string;
  shotNumber: number;
  shotType: string;
  releaseMs: number;
  outcome: Outcome;
  /** Null once the clip's media was deleted after analysis. */
  clipPathname: string | null;
  startMs: number;
  endMs: number;
  sizeBytes: number;
  analysisStatus: AnalysisStatus;
  analysis: unknown;
  mediaDeletedAt: string | null;
  /** The player's declared shooting hand, or null (then analysis detects it). */
  shootingHand: 'right' | 'left' | null;
  createdAt: string;
  updatedAt: string;
}
export type AnalysisStatus = 'pending' | 'complete' | 'failed' | 'expired';
export type NewClip = Omit<ClipRow, 'analysisStatus' | 'analysis' | 'mediaDeletedAt' | 'createdAt' | 'updatedAt' | 'clipPathname' | 'shootingHand'> & {
  clipPathname: string;
  shootingHand?: 'right' | 'left' | null;
};

export interface ClipRepo {
  /** Insert or replace the clip for (userId, sessionId, shotNumber); a re-cut resets analysis to pending. */
  upsert(clip: NewClip): Promise<void>;
  /** False when the row does not exist. */
  patchOutcome(userId: string, sessionId: string, shotNumber: number, outcome: Outcome): Promise<boolean>;
  deleteOne(userId: string, sessionId: string, shotNumber: number): Promise<void>;
  deleteSession(userId: string, sessionId: string): Promise<void>;
  /** Ordered by sessionId, then shotNumber. */
  list(userId: string, sessionId?: string): Promise<ClipRow[]>;
  /** Oldest pending clips whose inputs are still within the retention window. */
  listPending(cutoff: string, limit: number): Promise<ClipRow[]>;
  get(userId: string, sessionId: string, shotNumber: number): Promise<ClipRow | null>;
  /** Writes analysis and status together, optionally only from the given status. */
  setAnalysis(userId: string, sessionId: string, shotNumber: number, status: AnalysisStatus, analysis: unknown, expected?: AnalysisStatus): Promise<boolean>;
  /** Sets the declared shooting hand on every clip of a session. */
  setShootingHand(userId: string, sessionId: string, hand: 'right' | 'left'): Promise<void>;
  /** Records that the clip mp4 and npz were deleted: clip_pathname = null, media_deleted_at = now. */
  markMediaDeleted(userId: string, sessionId: string, shotNumber: number): Promise<void>;
}

export class AuthError extends Error {}

export interface AuthVerifier {
  /** Returns the identity from a verified access token; throws AuthError otherwise. */
  verify(token: string): Promise<{ userId: string; isGuest: boolean }>;
}

export interface Trimmer {
  /** Container duration in ms; throws when the file is not a readable video. */
  probeDurationMs(input: string): Promise<number>;
  /** Writes an H.264/AAC MP4 of [startMs, endMs) cut frame-accurately from `input`. */
  trim(input: string, startMs: number, endMs: number, output: string): Promise<void>;
}

export interface Deps {
  blob: BlobStore;
  clips: ClipRepo;
  auth: AuthVerifier;
  guestSessions?: import('./guest-session.js').GuestSessions;
  trimmer: Trimmer;
  /** Shared secret the CV worker uses for POST /v1/internal/analysis; the route answers 503 without it. */
  cvToken?: string;
  /** Pro reference library (scripts and the coach's compare_to_reference). */
  references?: import('./coach/deps.js').ReferenceRepo;
  /** The AI coach; its routes answer 503 not_configured without it. */
  coach?: import('./coach/deps.js').CoachDeps;
  /** Durable daily usage for guest shot analyses, even when Coach is unavailable. */
  usage?: import('./coach/deps.js').CoachUsageRepo;
  /** Shared guest quota for analyses and Coach messages. Defaults to unlimited. */
  guestDailyLimit?: import('./coach/deps.js').GuestDailyLimit;
  /** Extra routes a dependency needs (the local blob store's presigned PUT/GET endpoint). */
  routes?: (app: import('fastify').FastifyInstance) => Promise<void>;
}

/** Blob pathnames. Every id is validated before it gets here, and userId always comes from the token. */
export const paths = {
  recording: (userId: string, sessionId: string, uploadId: string, ext: string) => `recordings/${userId}/${sessionId}/${uploadId}.${ext}`,
  recordingsOf: (userId: string, sessionId: string) => `recordings/${userId}/${sessionId}/`,
  clip: (userId: string, sessionId: string, shotNumber: number) => `clips/${userId}/${sessionId}/${shotNumber}.mp4`,
  clipsOf: (userId: string, sessionId: string) => `clips/${userId}/${sessionId}/`,
  analysis: (userId: string, sessionId: string, shotNumber: number) => `analysis/${userId}/${sessionId}/${shotNumber}.npz`,
  analysisOf: (userId: string, sessionId: string) => `analysis/${userId}/${sessionId}/`,
  reference: (clipId: string, file: string) => `reference/${clipId}/${file}`,
  referenceOf: (clipId: string) => `reference/${clipId}/`,
};

export function clipWindow(releaseMs: number, durationMs: number): { startMs: number; endMs: number } {
  return { startMs: Math.max(0, releaseMs - CLIP_BEFORE_MS), endMs: Math.min(durationMs, releaseMs + CLIP_AFTER_MS) };
}
