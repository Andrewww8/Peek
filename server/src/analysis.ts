/**
 * POST /v1/internal/analysis: the CV worker hands over one shot's npz.
 * Order, so a crash at any point is safe (PROJECT_CONTEXT.md, "Shot analysis"):
 *   1. compute metrics and the compact pose from the npz;
 *   2. write analysis + analysis_status in ONE update;
 *   3. only then delete the npz and the clip mp4, and set media_deleted_at.
 * A crash before 2 leaves the inputs for a retry; a crash after 2 leaves files
 * the Blob TTL removes. A retry after 2 skips straight to the cleanup.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './clips.js';
import { AnalysisError, analyzeClipNpz } from './cv/metrics.js';
import { NpzError } from './cv/npz.js';
import { CLIP_TTL_MS, MAX_INLINE_NPZ_BYTES, MAX_NPZ_BYTES, SIGNED_GET_TTL_MS, UUID, paths, type BlobStore, type ClipRepo } from './deps.js';

const PENDING_BATCH_SIZE = 8;

export interface AnalysisResult {
  status: 'complete' | 'failed';
  /** True when the shot had already been analyzed (an idempotent retry). */
  alreadyAnalyzed: boolean;
  error?: { code: string; message: string };
  metrics?: unknown;
  quality?: unknown;
}

async function readAll(stream: NodeJS.ReadableStream, max: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as unknown as Uint8Array);
    size += b.length;
    if (size > max) throw new ApiError(413, 'npz_too_large', `npz files are limited to ${max} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

async function readAnalysisBlob(blob: BlobStore, pathname: string) {
  const head = await blob.head(pathname);
  if (!head) throw new ApiError(404, 'npz_not_found', `upload the npz to ${pathname} first`);
  if (head.sizeBytes > MAX_NPZ_BYTES) throw new ApiError(413, 'npz_too_large', `npz files are limited to ${MAX_NPZ_BYTES} bytes`);
  const stream = await blob.read(pathname);
  if (!stream) throw new ApiError(404, 'npz_not_found', 'the npz was deleted');
  return readAll(stream, MAX_NPZ_BYTES);
}

/** Accepts a small worker result directly or reads the existing Blob input used by cv-attach. */
export async function runShotAnalysis(
  deps: { blob: BlobStore; clips: ClipRepo }, userId: string, sessionId: string, shotNumber: number,
  inlinePose?: Uint8Array,
): Promise<AnalysisResult> {
  const { blob, clips } = deps;
  const row = await clips.get(userId, sessionId, shotNumber);
  if (!row) throw new ApiError(404, 'clip_not_found', 'no clip row for this shot');
  const npzPath = paths.analysis(userId, sessionId, shotNumber);
  const clipPath = paths.clip(userId, sessionId, shotNumber);

  const cleanup = async () => {
    await blob.delete(npzPath);
    await blob.delete(row.clipPathname ?? clipPath);
    await clips.markMediaDeleted(userId, sessionId, shotNumber);
  };

  if (row.analysisStatus === 'complete' || row.analysisStatus === 'failed') {
    if (!row.mediaDeletedAt) await cleanup();
    const a = row.analysis as { metrics?: unknown; quality?: unknown; error?: { code: string; message: string } } | null;
    return { status: row.analysisStatus, alreadyAnalyzed: true, metrics: a?.metrics, quality: a?.quality, error: a?.error };
  }

  if (inlinePose && row.analysisStatus !== 'pending') {
    throw new ApiError(409, 'analysis_changed', 'the clip is no longer pending');
  }
  const bytes = inlinePose ?? await readAnalysisBlob(blob, npzPath);

  let result: AnalysisResult;
  let storedAnalysis: unknown;
  try {
    const analysis = analyzeClipNpz(bytes, { releaseMs: row.releaseMs, startMs: row.startMs, endMs: row.endMs, declaredHand: row.shootingHand ?? undefined });
    storedAnalysis = analysis;
    result = { status: 'complete', alreadyAnalyzed: false, metrics: analysis.metrics, quality: analysis.quality };
  } catch (err) {
    if (!(err instanceof AnalysisError || err instanceof NpzError)) throw err;
    const error = { code: err instanceof AnalysisError ? err.code : 'invalid_npz', message: err.message };
    storedAnalysis = { version: 1, error };
    result = { status: 'failed', alreadyAnalyzed: false, error };
  }
  if (!(await clips.setAnalysis(userId, sessionId, shotNumber, result.status, storedAnalysis, row.analysisStatus))) {
    const latest = await clips.get(userId, sessionId, shotNumber);
    if (!latest) throw new ApiError(404, 'clip_not_found', 'the clip row was deleted');
    throw new ApiError(409, 'analysis_changed', 'the clip changed while it was being analyzed');
  }
  await cleanup();
  return result;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function analysisRoutes(app: FastifyInstance, opts: { blob?: BlobStore; clips?: ClipRepo; cvToken?: string }) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
    const code = (err as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number' && code >= 400 && code < 500) return reply.code(code).send({ error: 'invalid_request', message: (err as Error).message });
    req.log.error({ err }, 'analysis request failed');
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  const { blob, clips, cvToken } = opts;
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!blob || !clips || !cvToken) throw new ApiError(503, 'not_configured', 'CV_SERVICE_TOKEN is not set');
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!m || !sameSecret(m[1]!, cvToken)) throw new ApiError(401, 'unauthorized');
  });

  app.get('/v1/internal/analysis/jobs', async (req) => {
    const now = Date.now();
    const cutoff = new Date(now - CLIP_TTL_MS).toISOString();
    const rows = await clips!.listPending(cutoff, PENDING_BATCH_SIZE);
    if (rows.length === 0) return { jobs: [] };
    const urls = await blob!.signedGetUrls(
      rows.map((r) => r.clipPathname!),
      now + SIGNED_GET_TTL_MS,
      `${req.protocol}://${req.host}`,
    );
    return {
      jobs: rows.map((r, i) => ({
        userId: r.userId,
        sessionId: r.sessionId,
        shotNumber: r.shotNumber,
        releaseOffsetMs: r.releaseMs - r.startMs,
        sizeBytes: r.sizeBytes,
        url: urls[i]!,
      })),
    };
  });

  app.post('/v1/internal/analysis', async (req) => {
    const b = req.body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object') throw new ApiError(400, 'invalid_request', 'body must be a JSON object');
    if (typeof b.userId !== 'string' || !UUID.test(b.userId)) throw new ApiError(400, 'invalid_request', 'userId must be a UUID');
    if (typeof b.sessionId !== 'string' || !UUID.test(b.sessionId)) throw new ApiError(400, 'invalid_request', 'sessionId must be a UUID');
    if (!Number.isSafeInteger(b.shotNumber) || (b.shotNumber as number) < 1) throw new ApiError(400, 'invalid_request', 'shotNumber must be a positive integer');
    const userId = b.userId.toLowerCase(), sessionId = b.sessionId.toLowerCase(), shotNumber = b.shotNumber as number;
    const deps = { blob: blob!, clips: clips! }; // The onRequest hook requires both.
    if (b.npzBase64 !== undefined) {
      if (b.npzPathname !== undefined || typeof b.npzBase64 !== 'string' || !b.npzBase64) {
        throw new ApiError(400, 'invalid_request', 'send a single base64 NPZ or an NPZ pathname');
      }
      if (b.npzBase64.length > 4 * Math.ceil(MAX_INLINE_NPZ_BYTES / 3)) {
        throw new ApiError(413, 'npz_too_large', `inline NPZ files are limited to ${MAX_INLINE_NPZ_BYTES} bytes`);
      }
      const bytes = Buffer.from(b.npzBase64, 'base64');
      if (bytes.length > MAX_INLINE_NPZ_BYTES) {
        throw new ApiError(413, 'npz_too_large', `inline NPZ files are limited to ${MAX_INLINE_NPZ_BYTES} bytes`);
      }
      if (bytes.toString('base64') !== b.npzBase64) throw new ApiError(400, 'invalid_request', 'npzBase64 is invalid');
      return runShotAnalysis(deps, userId, sessionId, shotNumber, bytes);
    }
    // The npz must sit at the shot's own path: the worker cannot point the API at another blob.
    const expected = paths.analysis(userId, sessionId, shotNumber);
    if (b.npzPathname !== expected) throw new ApiError(400, 'invalid_request', `npzPathname must be ${expected}`);
    return runShotAnalysis(deps, userId, sessionId, shotNumber);
  });
}
