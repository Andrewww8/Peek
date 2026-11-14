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
  put(pathname: string, body: Buffer, contentType: string): Promise<void>;
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
  clipPathname: string;
  startMs: number;
  endMs: number;
  sizeBytes: number;
  analysisStatus: string;
  analysis: unknown;
  createdAt: string;
  updatedAt: string;
}
export type NewClip = Omit<ClipRow, 'analysisStatus' | 'analysis' | 'createdAt' | 'updatedAt'>;

export interface ClipRepo {
  /** Insert or replace the clip for (userId, sessionId, shotNumber); a re-cut resets analysis to pending. */
  upsert(clip: NewClip): Promise<void>;
  /** False when the row does not exist. */
  patchOutcome(userId: string, sessionId: string, shotNumber: number, outcome: Outcome): Promise<boolean>;
  deleteOne(userId: string, sessionId: string, shotNumber: number): Promise<void>;
  deleteSession(userId: string, sessionId: string): Promise<void>;
  /** Ordered by sessionId, then shotNumber. */
  list(userId: string, sessionId?: string): Promise<ClipRow[]>;
}

export class AuthError extends Error {}

export interface AuthVerifier {
  /** Returns the user id (a UUID) for a valid access token; throws AuthError otherwise. */
  verify(token: string): Promise<string>;
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
  trimmer: Trimmer;
  /** Extra routes a dependency needs (the local blob store's presigned PUT/GET endpoint). */
  routes?: (app: import('fastify').FastifyInstance) => Promise<void>;
}

/** Blob pathnames. Every id is validated before it gets here, and userId always comes from the token. */
export const paths = {
  recording: (userId: string, sessionId: string, uploadId: string, ext: string) => `recordings/${userId}/${sessionId}/${uploadId}.${ext}`,
  recordingsOf: (userId: string, sessionId: string) => `recordings/${userId}/${sessionId}/`,
  clip: (userId: string, sessionId: string, shotNumber: number) => `clips/${userId}/${sessionId}/${shotNumber}.mp4`,
  clipsOf: (userId: string, sessionId: string) => `clips/${userId}/${sessionId}/`,
};

export function clipWindow(releaseMs: number, durationMs: number): { startMs: number; endMs: number } {
  return { startMs: Math.max(0, releaseMs - CLIP_BEFORE_MS), endMs: Math.min(durationMs, releaseMs + CLIP_AFTER_MS) };
}
