/**
 * Dev tool: attach a CV npz to one stored shot and run the analysis step, so the
 * whole chain can be exercised before the CV worker exists.
 *
 *   npm run cv-attach -w server -- <npz> <userId> <sessionId> <shotNumber> [--api http://127.0.0.1:3001]
 *
 * It uploads the npz to analysis/<userId>/<sessionId>/<shot>.npz in the same Blob
 * store the server uses (local or production, chosen from env like the server),
 * then calls POST /v1/internal/analysis with CV_SERVICE_TOKEN when --api is given,
 * or runs the analysis in-process otherwise. Use --api when a local server is
 * running: it keeps its clip rows in memory.
 */
import { readFile } from 'node:fs/promises';
import { runShotAnalysis } from '../src/analysis.js';
import { CLIP_TTL_DAYS, UUID, paths, type BlobStore, type ClipRepo } from '../src/deps.js';
import { LOCAL_CV_TOKEN } from '../src/local/index.js';

export interface CvAttachOptions {
  npzFile: string;
  userId: string;
  sessionId: string;
  shotNumber: number;
  api?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export async function cvAttach(deps: { blob: BlobStore; clips: ClipRepo }, o: CvAttachOptions) {
  if (!UUID.test(o.userId) || !UUID.test(o.sessionId) || !(o.shotNumber >= 1)) throw new Error('userId and sessionId must be UUIDs, shotNumber a positive integer');
  const userId = o.userId.toLowerCase(), sessionId = o.sessionId.toLowerCase();
  const npzPathname = paths.analysis(userId, sessionId, o.shotNumber);
  await deps.blob.put(npzPathname, await readFile(o.npzFile), 'application/octet-stream', { ttlDays: CLIP_TTL_DAYS });
  if (!o.api) return runShotAnalysis(deps, userId, sessionId, o.shotNumber);
  const res = await (o.fetchImpl ?? fetch)(`${o.api.replace(/\/+$/, '')}/v1/internal/analysis`, {
    method: 'POST',
    headers: { authorization: `Bearer ${o.token ?? LOCAL_CV_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ userId, sessionId, shotNumber: o.shotNumber, npzPathname }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`analysis failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const apiAt = args.indexOf('--api');
  const api = apiAt >= 0 ? args.splice(apiAt, 2)[1] : undefined;
  const [npzFile, userId, sessionId, shot] = args;
  if (!npzFile || !userId || !sessionId || !shot) {
    console.error('usage: cv-attach <npz> <userId> <sessionId> <shotNumber> [--api <url>]');
    process.exit(2);
  }
  const { depsFromEnv } = await import('../src/env.js');
  const result = await cvAttach(depsFromEnv(process.env), { npzFile, userId, sessionId, shotNumber: Number(shot), api, token: process.env.CV_SERVICE_TOKEN });
  console.log(JSON.stringify(result, null, 2));
}
