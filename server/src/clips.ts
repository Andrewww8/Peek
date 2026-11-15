/**
 * Authenticated shot-clip endpoints (PROJECT_CONTEXT.md, "Authenticated endpoints").
 * Every blob pathname and row key is built from the token's user id, never from the client.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { coachRoutes } from './coach/routes.js';
import {
  AuthError,
  CLIP_TTL_DAYS,
  CLIP_TTL_MS,
  DURATION_TOLERANCE_MS,
  MAX_RECORDING_BYTES,
  MAX_RECORDING_DURATION_MS,
  MAX_SHOTS_PER_REQUEST,
  OUTCOMES,
  RECORDING_TYPES,
  SIGNED_GET_TTL_MS,
  UPLOAD_URL_TTL_MS,
  UUID,
  clipWindow,
  paths,
  type Deps,
  type Outcome,
} from './deps.js';

/** A response with a precise error code: `{ error: code, ...extra }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

const bad = (message: string) => new ApiError(400, 'invalid_request', message);
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isCount = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const SHOT_TYPE = /^[a-z0-9_]{1,64}$/;
const CONTENT_TYPES = new Set(Object.values(RECORDING_TYPES));

function sessionParam(v: unknown): string {
  if (!isUuid(v)) throw bad('sessionId must be a UUID');
  return v.toLowerCase();
}
function shotNumberParam(v: unknown): number {
  const n = typeof v === 'string' && /^[1-9][0-9]{0,8}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) throw bad('shotNumber must be a positive integer');
  return n;
}
function outcomeOf(v: unknown, where = 'outcome'): Outcome {
  if (!OUTCOMES.includes(v as Outcome)) throw bad(`${where} must be one of ${OUTCOMES.join(', ')}`);
  return v as Outcome;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

export interface ClipRouteOptions {
  deps?: Deps;
  /** Why deps are missing (production env not configured); answered as 503 not_configured. */
  depsError?: string;
}

export async function clipRoutes(app: FastifyInstance, opts: ClipRouteOptions): Promise<void> {
  const { deps } = opts;
  app.decorateRequest('userId', '');

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
    const code = (err as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number' && code >= 400 && code < 500) {
      // Fastify's own 4xx: malformed JSON, wrong content type, body too large.
      return reply.code(code).send({ error: 'invalid_request', message: (err as Error).message });
    }
    req.log.error({ err }, 'clip API request failed');
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  app.addHook('onRequest', async (req) => {
    if (!deps) throw new ApiError(503, 'not_configured', opts.depsError ?? 'clip storage is not configured');
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!m) throw new ApiError(401, 'unauthorized');
    try {
      req.userId = (await deps.auth.verify(m[1]!)).toLowerCase();
    } catch (err) {
      if (err instanceof AuthError) throw new ApiError(401, 'unauthorized');
      throw err;
    }
  });
  // The onRequest hook has already answered 503 when deps are missing.
  const { blob, clips, trimmer } = deps ?? ({} as Deps);
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

  app.post('/v1/recordings', async (req) => {
    const b = req.body;
    if (!isObject(b)) throw bad('body must be a JSON object');
    const sessionId = sessionParam(b.sessionId);
    if (typeof b.ext !== 'string' || !(b.ext in RECORDING_TYPES)) {
      throw new ApiError(415, 'unsupported_media_type', `ext must be one of ${Object.keys(RECORDING_TYPES).join(', ')}`);
    }
    if (typeof b.contentType !== 'string' || !CONTENT_TYPES.has(b.contentType)) {
      throw new ApiError(415, 'unsupported_media_type', `contentType must be one of ${[...CONTENT_TYPES].join(', ')}`);
    }
    if (!isCount(b.sizeBytes, 1)) throw bad('sizeBytes must be a positive integer');
    // null: the phone recovered the session after a kill and does not know the duration; the cut step probes it.
    if (b.durationMs !== null && !isCount(b.durationMs, 1)) throw bad('durationMs must be a positive integer or null');
    if (b.sizeBytes > MAX_RECORDING_BYTES) {
      throw new ApiError(413, 'recording_too_large', `recordings are limited to ${MAX_RECORDING_BYTES} bytes`);
    }
    if (b.durationMs !== null && b.durationMs > MAX_RECORDING_DURATION_MS) {
      throw new ApiError(422, 'recording_too_long', `recordings are limited to ${MAX_RECORDING_DURATION_MS} ms`);
    }
    const uploadId = randomUUID();
    const put = await blob.presignPut({
      pathname: paths.recording(req.userId, sessionId, uploadId, b.ext),
      contentType: b.contentType,
      maxBytes: b.sizeBytes,
      expiresAt: Date.now() + UPLOAD_URL_TTL_MS,
      origin: origin(req),
    });
    return { uploadId, uploadUrl: put.url, method: 'PUT', headers: put.headers, expiresAt: new Date(put.expiresAt).toISOString() };
  });

  app.post<{ Params: { uploadId: string } }>('/v1/recordings/:uploadId/clips', async (req) => {
    if (!isUuid(req.params.uploadId)) throw bad('uploadId must be a UUID');
    const uploadId = req.params.uploadId.toLowerCase();
    const b = req.body;
    if (!isObject(b)) throw bad('body must be a JSON object');
    const sessionId = sessionParam(b.sessionId);
    if (typeof b.shotType !== 'string' || !SHOT_TYPE.test(b.shotType)) throw bad('shotType must be snake_case');
    const shotType = b.shotType;
    // Optional player-declared shooting hand for the session: "R" or "L". Analysis uses it instead of detecting.
    if (b.shootingHand !== undefined && b.shootingHand !== null && b.shootingHand !== 'R' && b.shootingHand !== 'L') throw bad('shootingHand must be "R" or "L"');
    const shootingHand = b.shootingHand === 'R' ? 'right' : b.shootingHand === 'L' ? 'left' : null;
    if (!Array.isArray(b.shots) || b.shots.length === 0 || b.shots.length > MAX_SHOTS_PER_REQUEST) {
      throw bad(`shots must be an array of 1 to ${MAX_SHOTS_PER_REQUEST} shots`);
    }
    const seen = new Set<number>();
    const shots = b.shots.map((s: unknown, i: number) => {
      if (!isObject(s)) throw bad(`shots[${i}] must be an object`);
      if (!isCount(s.shotNumber, 1)) throw bad(`shots[${i}].shotNumber must be a positive integer`);
      if (!isCount(s.releaseMs, 0)) throw bad(`shots[${i}].releaseMs must be a non-negative integer`);
      if (seen.has(s.shotNumber)) throw bad(`shots[${i}].shotNumber ${s.shotNumber} is repeated`);
      seen.add(s.shotNumber);
      return { shotNumber: s.shotNumber, releaseMs: s.releaseMs, outcome: outcomeOf(s.outcome, `shots[${i}].outcome`) };
    });

    const userId = req.userId;
    if (shootingHand) await clips.setShootingHand(userId, sessionId, shootingHand);
    const existing = new Map((await clips.list(userId, sessionId)).map((r) => [r.shotNumber, r]));
    const toCut = shots.filter((s) => !existing.has(s.shotNumber));
    const results = new Map<number, { shotNumber: number; startMs: number; endMs: number; sizeBytes: number }>();
    const failed = new Map<number, { shotNumber: number; error: string; message: string; durationMs: number }>();

    const recording = await findRecording(userId, sessionId, uploadId);
    if (toCut.length) {
      if (!recording) throw new ApiError(404, 'recording_not_found', 'upload the recording first, or it was already deleted');
      if (recording.sizeBytes > MAX_RECORDING_BYTES) {
        throw new ApiError(413, 'recording_too_large', `recordings are limited to ${MAX_RECORDING_BYTES} bytes`);
      }
      const dir = await mkdtemp(join(tmpdir(), 'perspective-cut-'));
      try {
        const input = join(dir, `recording.${recording.ext}`);
        const stream = await blob.read(recording.pathname);
        if (!stream) throw new ApiError(404, 'recording_not_found', 'the recording was deleted');
        await pipeline(stream, createWriteStream(input));
        let durationMs: number;
        try {
          durationMs = await trimmer.probeDurationMs(input);
        } catch {
          throw new ApiError(422, 'recording_unreadable', 'the recording is not a readable video');
        }
        if (durationMs > MAX_RECORDING_DURATION_MS + DURATION_TOLERANCE_MS) {
          throw new ApiError(422, 'recording_too_long', `recordings are limited to ${MAX_RECORDING_DURATION_MS} ms`);
        }
        // A release after the end can never be cut from this recording: report it for that shot, cut the rest.
        for (const s of toCut.filter((s) => s.releaseMs > durationMs)) {
          failed.set(s.shotNumber, {
            shotNumber: s.shotNumber,
            error: 'release_beyond_duration',
            message: `shot ${s.shotNumber} releases at ${s.releaseMs} ms, after the end (${durationMs} ms)`,
            durationMs,
          });
        }
        for (const s of toCut.filter((s) => !failed.has(s.shotNumber))) {
          const { startMs, endMs } = clipWindow(s.releaseMs, durationMs);
          const out = join(dir, `${s.shotNumber}.mp4`);
          await trimmer.trim(input, startMs, endMs, out);
          const body = await readFile(out);
          const clipPathname = paths.clip(userId, sessionId, s.shotNumber);
          // Clips are temporary inputs to analysis: Blob removes them after 7 days if CV never runs.
          await blob.put(clipPathname, body, 'video/mp4', { ttlDays: CLIP_TTL_DAYS });
          await clips.upsert({ userId, sessionId, shotNumber: s.shotNumber, shotType, releaseMs: s.releaseMs, outcome: s.outcome, clipPathname, startMs, endMs, sizeBytes: body.length, shootingHand });
          results.set(s.shotNumber, { shotNumber: s.shotNumber, startMs, endMs, sizeBytes: body.length });
          await rm(out, { force: true });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    // Shots stored by an earlier call: keep the clip, take the phone's latest outcome.
    for (const s of shots) {
      const row = existing.get(s.shotNumber);
      if (!row) continue;
      if (row.outcome !== s.outcome) await clips.patchOutcome(userId, sessionId, s.shotNumber, s.outcome);
      results.set(s.shotNumber, { shotNumber: s.shotNumber, startMs: row.startMs, endMs: row.endMs, sizeBytes: row.sizeBytes });
    }
    // Every shot that can be cut now has a stored clip and row, so the recording can go, together with
    // any older upload for this session left behind by a kill between the PUT and this call.
    if (recording) {
      await blob.delete(recording.pathname);
      await blob.deletePrefix(paths.recordingsOf(userId, sessionId));
    }
    // Every requested shot is in the answer: a clip, or a per-shot error.
    return { clips: shots.map((s) => results.get(s.shotNumber) ?? failed.get(s.shotNumber)!) };
  });

  async function findRecording(userId: string, sessionId: string, uploadId: string) {
    for (const ext of Object.keys(RECORDING_TYPES)) {
      const pathname = paths.recording(userId, sessionId, uploadId, ext);
      const found = await blob.head(pathname);
      if (found) return { pathname, ext, sizeBytes: found.sizeBytes };
    }
    return null;
  }

  app.patch<{ Params: { sessionId: string; shotNumber: string } }>('/v1/sessions/:sessionId/shots/:shotNumber', async (req) => {
    const sessionId = sessionParam(req.params.sessionId);
    const shotNumber = shotNumberParam(req.params.shotNumber);
    if (!isObject(req.body)) throw bad('body must be a JSON object');
    const outcome = outcomeOf(req.body.outcome);
    if (!(await clips.patchOutcome(req.userId, sessionId, shotNumber, outcome))) {
      throw new ApiError(404, 'clip_not_found', 'no clip is stored for this shot');
    }
    return { sessionId, shotNumber, outcome };
  });

  app.delete<{ Params: { sessionId: string; shotNumber: string } }>('/v1/sessions/:sessionId/shots/:shotNumber', async (req, reply) => {
    const sessionId = sessionParam(req.params.sessionId);
    const shotNumber = shotNumberParam(req.params.shotNumber);
    // Row first: a listing never points at a deleted clip, and a retry still removes the blob by its fixed path.
    await clips.deleteOne(req.userId, sessionId, shotNumber);
    await blob.delete(paths.clip(req.userId, sessionId, shotNumber));
    await blob.delete(paths.analysis(req.userId, sessionId, shotNumber));
    return reply.code(204).send();
  });

  app.delete<{ Params: { sessionId: string } }>('/v1/sessions/:sessionId', async (req, reply) => {
    const sessionId = sessionParam(req.params.sessionId);
    await clips.deleteSession(req.userId, sessionId);
    await blob.deletePrefix(paths.clipsOf(req.userId, sessionId));
    await blob.deletePrefix(paths.recordingsOf(req.userId, sessionId));
    await blob.deletePrefix(paths.analysisOf(req.userId, sessionId));
    return reply.code(204).send();
  });

  coachRoutes(app, { coach: deps?.coach, clips, sessionParam });

  app.get<{ Querystring: { sessionId?: string } }>('/v1/clips', async (req) => {
    const q = req.query.sessionId;
    const sessionId = q === undefined ? undefined : sessionParam(q);
    const rows = await clips.list(req.userId, sessionId);
    // A clip whose 7-day TTL passed before CV ran is gone from Blob: record it as expired.
    for (const r of rows) {
      if (r.analysisStatus === 'pending' && Date.now() - Date.parse(r.createdAt) > CLIP_TTL_MS) {
        await clips.setAnalysis(r.userId, r.sessionId, r.shotNumber, 'expired', null);
        r.analysisStatus = 'expired';
      }
    }
    // Only clips still waiting for analysis have media; analyzed shots are kept as data only.
    const withMedia = rows.filter((r) => r.analysisStatus === 'pending' && r.clipPathname);
    const expiresAt = Date.now() + SIGNED_GET_TTL_MS;
    const signed = withMedia.length ? await blob.signedGetUrls(withMedia.map((r) => r.clipPathname!), expiresAt, origin(req)) : [];
    const urlOf = new Map(withMedia.map((r, i) => [r.shotNumber + '|' + r.sessionId, signed[i]!]));
    return {
      clips: rows.map((r) => {
        const url = urlOf.get(r.shotNumber + '|' + r.sessionId) ?? null;
        const a = r.analysisStatus === 'complete' ? (r.analysis as { metrics?: unknown; quality?: unknown } | null) : null;
        return {
          sessionId: r.sessionId,
          shotNumber: r.shotNumber,
          shotType: r.shotType,
          releaseMs: r.releaseMs,
          outcome: r.outcome,
          startMs: r.startMs,
          endMs: r.endMs,
          sizeBytes: r.sizeBytes,
          analysisStatus: r.analysisStatus,
          metrics: a?.metrics ?? null,
          quality: a?.quality ?? null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          url,
          urlExpiresAt: url ? new Date(expiresAt).toISOString() : null,
        };
      }),
    };
  });
}
