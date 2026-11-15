/**
 * Reviews reference shot candidates. The coach uses only verified shots.
 *
 *   npm run reference-review -w server                      # list candidates (clip, frame, timestamp)
 *   npm run reference-review -w server -- --verify <id…>    # mark shots verified
 *   npm run reference-review -w server -- --reject <id…>    # delete candidates that are not real shots
 *   npm run reference-review -w server -- --finalize <clipId>
 *       # after review: delete the clip's source video and npz from Blob and drop its
 *       # unverified candidates. Verified shots keep their metrics and compact pose.
 */
import type { ReferenceRepo } from '../src/coach/deps.js';
import type { ShotAnalysis } from '../src/cv/metrics.js';
import { paths, type BlobStore } from '../src/deps.js';

export type ReviewCommand = { list: true } | { verify: string[] } | { reject: string[] } | { finalize: string };

export async function reviewReference(deps: { blob: BlobStore; references: ReferenceRepo }, cmd: ReviewCommand): Promise<string[]> {
  const { references } = deps;
  if ('verify' in cmd) return [`verified ${await references.setVerified(cmd.verify, true)} shot(s)`];
  if ('reject' in cmd) return [`rejected ${await references.deleteShots(cmd.reject)} candidate(s)`];
  if ('finalize' in cmd) {
    const clip = (await references.listClips()).find((c) => c.id === cmd.finalize);
    if (!clip) throw new Error(`no reference clip ${cmd.finalize}`);
    const unverified = (await references.listShots({ clipId: clip.id, verified: false })).map((s) => s.id);
    await references.deleteShots(unverified);
    await deps.blob.deletePrefix(paths.referenceOf(clip.id));
    await references.clearMedia(clip.id);
    const kept = (await references.listShots({ clipId: clip.id, verified: true })).length;
    return [`finalized ${clip.title}: deleted source media and ${unverified.length} unverified candidate(s); ${kept} verified shot(s) kept as data`];
  }
  const clips = new Map((await references.listClips()).map((c) => [c.id, c]));
  const lines: string[] = [];
  for (const s of await references.listShots()) {
    const clip = clips.get(s.clipId);
    const a = s.metrics as ShotAnalysis;
    const t = clip ? (s.releaseFrame / clip.fps).toFixed(2) : '?';
    lines.push(
      `${s.id}  ${s.verified ? 'VERIFIED ' : 'candidate'}  ${clip?.title ?? s.clipId}  track ${s.track}  frame ${s.releaseFrame}  t=${t}s  ` +
        `${a?.metrics?.shootingHand ?? '?'} hand  elbow@release ${a?.metrics?.elbowAngleReleaseDeg ?? '–'}°${clip?.npzPathname ? '' : '  (media deleted)'}`,
    );
  }
  return lines.length ? lines : ['no reference shots'];
}

if (import.meta.filename === process.argv[1]) {
  const [op, ...rest] = process.argv.slice(2);
  const cmd: ReviewCommand =
    op === '--verify' ? { verify: rest } : op === '--reject' ? { reject: rest } : op === '--finalize' && rest[0] ? { finalize: rest[0] } : { list: true };
  const { depsFromEnv } = await import('../src/env.js');
  const deps = depsFromEnv(process.env);
  for (const line of await reviewReference(deps as typeof deps & { references: ReferenceRepo }, cmd)) console.log(line);
}
