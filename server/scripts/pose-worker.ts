import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_INLINE_NPZ_BYTES, UUID } from '../src/deps.js';

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

interface ResidentLiftOptions {
  python: string;
  lifter: string;
  coachPath: string;
  env: NodeJS.ProcessEnv;
  /** Per-job limit, as for a one-shot lift; a hung job kills the process and the next job restarts it. */
  timeoutMs?: number;
}

/**
 * Runs lift-shot.py once in its resident mode and sends it one job at a time, so Python, its
 * imports and the pose models load once per worker instead of once per clip. A crash, a timeout
 * or an abort ends the process; the next job starts a fresh one.
 */
export function createResidentLift({ python, lifter, coachPath, env, timeoutMs = 240_000 }: ResidentLiftOptions) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let started: Promise<void> | null = null;
  let waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let stderrTail = '';

  const fail = (error: Error) => {
    const w = waiter;
    waiter = null;
    w?.reject(error);
  };
  const nextLine = () => new Promise<string>((resolve, reject) => {
    waiter = { resolve, reject };
  });
  const stop = () => {
    const c = child;
    child = null;
    started = null;
    c?.kill('SIGKILL');
  };

  function start() {
    const c = spawn(python, [lifter, '--serve', coachPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child = c;
    stderrTail = '';
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', (d: string) => {
      stderrTail = (stderrTail + d).slice(-4_000);
    });
    // Events from a process that was already replaced must not touch the current job.
    createInterface({ input: c.stdout }).on('line', (line) => {
      if (child !== c) return;
      const w = waiter;
      waiter = null;
      w?.resolve(line);
    });
    c.on('error', (error) => {
      if (child !== c) return;
      stop();
      fail(error);
    });
    c.on('exit', (code, signal) => {
      if (child !== c) return;
      stop();
      fail(new Error(`The pose lifter exited (${signal ?? code}). ${stderrTail.trim().split('\n').slice(-3).join(' ')}`.trim()));
    });
    c.stdin.on('error', () => {}); // a crash mid-write surfaces through 'exit'
    return nextLine().then((line) => {
      if (!(JSON.parse(line) as { ready?: boolean }).ready) throw new Error('The pose lifter did not start.');
    });
  }

  function ready() {
    started ??= start().catch((error: Error) => {
      stop();
      throw error;
    });
    return started;
  }

  async function runJob(video: string, releaseOffsetMs: number, output: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const limit = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const onAbort = () => {
      stop();
      fail(limit.reason instanceof Error ? limit.reason : new Error('The pose lift was cancelled.'));
    };
    limit.addEventListener('abort', onAbort, { once: true });
    try {
      await ready();
      limit.throwIfAborted();
      const answer = nextLine();
      child!.stdin.write(JSON.stringify({ video, release_offset_ms: releaseOffsetMs, output }) + '\n');
      let reply: { ok?: boolean; error?: string };
      try {
        reply = JSON.parse(await answer) as typeof reply;
      } catch (error) {
        stop(); // an unreadable answer leaves the protocol out of step: start over
        throw error;
      }
      if (!reply.ok) throw new Error(`The pose lift failed: ${reply.error ?? 'unknown error'}`);
    } finally {
      limit.removeEventListener('abort', onAbort);
    }
  }

  const lift: Lift = (video, releaseOffsetMs, output, signal) => {
    const job = queue.then(() => runJob(video, releaseOffsetMs, output, signal));
    queue = job.catch(() => {});
    return job;
  };
  return { lift, ready, close: stop };
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
  const resident = createResidentLift({ python: SHOT_COACH_PYTHON, lifter, coachPath, env: modelEnv });
  const { lift } = resident;
  const watch = process.argv.includes('--watch');
  // Load the models while the first poll is in flight. A failure here is retried by the first job.
  if (watch) resident.ready().catch((error: Error) => console.error(error.message));
  try {
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
  } finally {
    resident.close();
  }
}

if (import.meta.filename === process.argv[1]) {
  await main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
