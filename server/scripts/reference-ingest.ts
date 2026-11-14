/**
 * Ingests professional reference footage: uploads the CV npz (and optionally the
 * source video) to the private reference/<id>/ area, runs the candidate shot
 * detector, and stores each candidate unverified with its metrics.
 *
 *   npm run reference-ingest -w server -- <npz> --title "…" --source "…" --rights-note "…" [--video <mp4>] [--shot-type three_point]
 *
 * Then review the candidates with reference-review.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ReferenceRepo } from '../src/coach/deps.js';
import { detectCandidates } from '../src/cv/detector.js';
import { poseArraysFromNpz } from '../src/cv/metrics.js';
import { paths, type BlobStore } from '../src/deps.js';

export interface IngestOptions {
  npzFile: string;
  videoFile?: string;
  title: string;
  source: string;
  rightsNote: string;
  shotType?: string;
}

export async function ingestReference(deps: { blob: BlobStore; references: ReferenceRepo }, o: IngestOptions) {
  if (!o.title || !o.source || !o.rightsNote) throw new Error('--title, --source and --rights-note are required');
  const shotType = o.shotType ?? 'three_point';
  const bytes = await readFile(o.npzFile);
  const pose = poseArraysFromNpz(bytes); // validate before uploading anything
  const candidates = detectCandidates(pose);
  const id = randomUUID();
  const npzPathname = paths.reference(id, 'source.npz');
  await deps.blob.put(npzPathname, bytes, 'application/octet-stream');
  let videoPathname: string | null = null;
  if (o.videoFile) {
    videoPathname = paths.reference(id, 'source.mp4');
    await deps.blob.put(videoPathname, await readFile(o.videoFile), 'video/mp4');
  }
  await deps.references.insertClip({ id, title: o.title, source: o.source, rightsNote: o.rightsNote, videoPathname, npzPathname, fps: pose.fps });
  await deps.references.insertShots(
    candidates.map((c) => ({ id: randomUUID(), clipId: id, track: c.track, releaseFrame: c.releaseFrame, shotType, verified: false, metrics: c.analysis })),
  );
  return { clipId: id, fps: pose.fps, candidates: candidates.map((c) => ({ track: c.track, releaseFrame: c.releaseFrame, timeSec: c.timeSec, hand: c.hand })) };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const npzFile = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
  if (!npzFile) {
    console.error('usage: reference-ingest <npz> --title … --source … --rights-note … [--video <mp4>] [--shot-type three_point]');
    process.exit(2);
  }
  const { depsFromEnv } = await import('../src/env.js');
  const deps = depsFromEnv(process.env);
  const r = await ingestReference(deps as typeof deps & { references: ReferenceRepo }, {
    npzFile,
    videoFile: flag(args, '--video'),
    title: flag(args, '--title') ?? '',
    source: flag(args, '--source') ?? '',
    rightsNote: flag(args, '--rights-note') ?? '',
    shotType: flag(args, '--shot-type'),
  });
  console.log(`reference clip ${r.clipId}: ${r.candidates.length} candidate shots (unverified)`);
  for (const c of r.candidates) console.log(`  track ${c.track}  frame ${c.releaseFrame}  t=${c.timeSec}s  ${c.hand} hand`);
  console.log('Review them with: npm run reference-review -w server');
}
