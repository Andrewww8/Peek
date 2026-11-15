import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { MAX_INLINE_NPZ_BYTES, UUID } from '../src/deps.js';

const run = promisify(execFile);
const jobsPath = '/v1/internal/analysis/jobs';
const analysisPath = '/v1/internal/analysis';
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

interface PoseJob {
  userId: string;
  sessionId: string;
  shotNumber: number;
  releaseOffsetMs: number;
  sizeBytes: number;
  url: string;
}

type Lift = (video: string, releaseOffsetMs: number, output: string, signal: AbortSignal) => Promise<void>;

function isPoseJob(job: unknown): job is PoseJob {
  if (!job || typeof job !== 'object') return false;
  const row = job as Partial<PoseJob>;
  return typeof row.userId === 'string' && UUID.test(row.userId) &&
    typeof row.sessionId === 'string' && UUID.test(row.sessionId) &&
    Number.isSafeInteger(row.shotNumber) && row.shotNumber! > 0 &&
    Number.isSafeInteger(row.releaseOffsetMs) && row.releaseOffsetMs! >= 0 &&
    Number.isSafeInteger(row.sizeBytes) && row.sizeBytes! > 0 && typeof row.url === 'string';
}

async function downloadClip(job: PoseJob, api: URL, destination: string, signal: AbortSignal) {
  const url = new URL(job.url);
  if (url.username || url.password || (url.protocol !== 'https:' && url.origin !== api.origin)) {
    throw new Error('The API returned an invalid clip URL.');
  }
  const response = await fetch(url, { redirect: 'error', signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Clip download returned HTTP ${response.status}.`);
  }
  let received = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > job.sizeBytes) callback(new Error('The clip exceeded its expected size.'));
      else callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    count,
    createWriteStream(destination, { mode: 0o600 }),
    { signal },
  );
  if (received !== job.sizeBytes) throw new Error('The downloaded clip size did not match.');
}

export async function processPoseBatch(api: URL, token: string, lift: Lift, signal: AbortSignal) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const jobResponse = await fetch(new URL(jobsPath, api), {
    headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!jobResponse.ok) {
    await jobResponse.body?.cancel();
    throw new Error(`Job lookup returned HTTP ${jobResponse.status}.`);
  }
  const { jobs } = await jobResponse.json() as { jobs?: unknown };
  if (!Array.isArray(jobs) || !jobs.every(isPoseJob)) throw new Error('The API returned invalid analysis jobs.');

  const results = { complete: 0, failed: 0, skipped: 0, retry: 0 };
  for (const job of jobs) {
    signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), 'peek-pose-'));
    try {
      const video = join(directory, 'clip.mp4');
      const output = join(directory, 'pose.npz');
      await downloadClip(job, api, video, AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
      await lift(video, job.releaseOffsetMs, output, signal);
      const size = (await stat(output)).size;
      if (size === 0 || size > MAX_INLINE_NPZ_BYTES) throw new Error('The exported pose size is invalid.');
      const npzBase64 = (await readFile(output)).toString('base64');
      const response = await fetch(new URL(analysisPath, api), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: job.userId, sessionId: job.sessionId, shotNumber: job.shotNumber, npzBase64 }),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      const result = await response.json() as { status?: string; error?: string };
      if (response.ok && (result.status === 'complete' || result.status === 'failed')) {
        results[result.status] += 1;
      } else if (result.error === 'clip_not_found' || result.error === 'analysis_changed') {
        results.skipped += 1;
      } else {
        throw new Error(`Submitting the pose returned HTTP ${response.status}.`);
      }
    } catch (error) {
      signal.throwIfAborted();
      console.error(`Shot ${job.shotNumber} will retry: ${(error as Error).message}`);
      results.retry += 1;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return results;
}

async function main() {
  const coachDir = resolve(import.meta.dirname, '../../shot_coach');
  const {
    PERSPECTIVE_API_URL, CV_SERVICE_TOKEN,
    SHOT_COACH_PATH = join(coachDir, 'shot_coach.py'),
    SHOT_COACH_PYTHON = join(coachDir, '.venv', 'bin', 'python'),
  } = process.env;
  if (!PERSPECTIVE_API_URL || !CV_SERVICE_TOKEN) {
    throw new Error('Set PERSPECTIVE_API_URL and CV_SERVICE_TOKEN.');
  }
  const api = new URL(PERSPECTIVE_API_URL);
  const local = api.protocol === 'http:' && loopback.has(api.hostname);
  if ((!local && api.protocol !== 'https:') || api.username || api.password ||
      api.pathname !== '/' || api.search || api.hash) {
    throw new Error('PERSPECTIVE_API_URL must be an HTTPS origin or a loopback HTTP origin.');
  }
  const coachPath = resolve(SHOT_COACH_PATH);
  await access(coachPath);
  if (!process.env.SHOT_COACH_PYTHON) {
    await access(SHOT_COACH_PYTHON).catch(() => {
      throw new Error('Set up the Python environment in shot_coach/.venv or set SHOT_COACH_PYTHON.');
    });
  }
  const lifter = join(import.meta.dirname, 'lift-shot.py');
  const controller = new AbortController();
  const { signal } = controller;
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const modelEnv = { ...process.env };
  delete modelEnv.CV_SERVICE_TOKEN;
  const lift: Lift = async (video, releaseOffsetMs, output, signal) => {
    await run(SHOT_COACH_PYTHON, [lifter, coachPath, video, String(releaseOffsetMs), output], {
      env: modelEnv, signal, timeout: 240_000, maxBuffer: 256 * 1024,
    });
  };
  const watch = process.argv.includes('--watch');
  do {
    try {
      const results = await processPoseBatch(api, CV_SERVICE_TOKEN, lift, signal);
      if (!watch || Object.values(results).some(Boolean)) console.log(results);
      if (!watch && results.retry > 0) process.exitCode = 1;
    } catch (error) {
      if (signal.aborted) return;
      if (!watch) throw error;
      console.error((error as Error).message);
    }
    if (watch && !signal.aborted) await delay(15_000, undefined, { signal }).catch(() => {});
  } while (watch && !signal.aborted);
}

if (import.meta.filename === process.argv[1]) {
  await main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
