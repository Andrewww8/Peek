/**
 * Candidate jump-shot detector for pro reference footage (long broadcast npz).
 * A candidate release, per track, is a frame where:
 *  - a wrist peaks above the head (local maximum within ±0.5 s, at least 5 % of the box height above the head),
 *  - that arm's elbow is extended past 150° (angles in 3D when available, else 2D),
 *  - the knees dipped by at least 15° within the second before (min knee angle vs. the max in that second),
 *  - no scene cut falls inside the 4 s shot window (3 s before to 1 s after),
 *  - and the track covers at least 70 % of the second before and half second after.
 * Candidates are proposals only: a person verifies each one with reference-review.
 */
import { NJ, J, type PoseSeries } from './pose.js';
import { analyzeSeries, seriesOf, trackRows, type PoseArrays, type ShotAnalysis } from './metrics.js';

export interface Candidate {
  track: number;
  releaseFrame: number;
  timeSec: number;
  hand: 'right' | 'left';
  analysis: ShotAnalysis;
}

/** Angle at b (degrees): 3D when all three joints have a 3D estimate, else 2D, like the metrics. */
const angleAt = (s: PoseSeries, i: number, a: number, b: number, c: number) => {
  const p = s.pose3d;
  const v3 = (j: number) => [p[(i * NJ + j) * 3]!, p[(i * NJ + j) * 3 + 1]!, p[(i * NJ + j) * 3 + 2]!];
  const k = s.kpts2d;
  const v2 = (j: number) => [k[(i * NJ + j) * 2]!, k[(i * NJ + j) * 2 + 1]!, 0];
  let A = v3(a), B = v3(b), C = v3(c);
  if (![...A, ...B, ...C].every(Number.isFinite)) (A = v2(a)), (B = v2(b)), (C = v2(c));
  const u = A.map((x, d) => x - B[d]!), w = C.map((x, d) => x - B[d]!);
  const den = Math.hypot(...u) * Math.hypot(...w);
  return den > 0 ? (Math.acos(Math.max(-1, Math.min(1, (u[0]! * w[0]! + u[1]! * w[1]! + u[2]! * w[2]!) / den))) * 180) / Math.PI : NaN;
};

export function detectCandidates(p: PoseArrays, opts: { shotType?: string } = {}): Candidate[] {
  void opts;
  const fps = p.fps;
  const fr = (ms: number) => Math.round((ms * fps) / 1000);
  const out: Candidate[] = [];
  for (const [track, rows] of trackRows(p)) {
    if (rows.length < fr(1500)) continue;
    const s = seriesOf(p, rows);
    const n = s.frames.length;
    const y = (i: number, j: number) => s.kpts2d[(i * NJ + j) * 2 + 1]!;
    const h = (i: number) => s.bbox[i * 4 + 3]! - s.bbox[i * 4 + 1]!;
    const lift = (i: number, w: number) => (h(i) > 0 ? (y(i, J.head) - y(i, w)) / h(i) : NaN);
    const knee = (i: number) => (angleAt(s, i, J.r_hip, J.r_knee, J.r_ankle) + angleAt(s, i, J.l_hip, J.l_knee, J.l_ankle)) / 2;
    const byFrame = new Map(s.frames.map((f, i) => [f, i]));
    let lastRelease = -Infinity;
    for (let i = 0; i < n; i++) {
      const f = s.frames[i]!;
      for (const [hand, sh, el, wr] of [['right', J.r_shoulder, J.r_elbow, J.r_wrist], ['left', J.l_shoulder, J.l_elbow, J.l_wrist]] as const) {
        const L = lift(i, wr);
        if (!(L >= 0.05)) continue;
        // Local maximum of the wrist lift within ±0.5 s; on a plateau (a held finish) the first frame counts.
        let isPeak = true;
        for (let k = i - 1; k >= 0 && s.frames[k]! >= f - fr(500); k--) if (lift(k, wr) >= L) isPeak = false;
        for (let k = i + 1; k < n && s.frames[k]! <= f + fr(500) && isPeak; k++) if (lift(k, wr) > L) isPeak = false;
        if (!isPeak) continue;
        if (!(angleAt(s, i, sh, el, wr) >= 150)) continue;
        const prev: number[] = [];
        for (let k = i; k >= 0 && s.frames[k]! >= f - fr(1000); k--) prev.push(knee(k));
        const finite = prev.filter(Number.isFinite);
        if (finite.length < 3 || Math.max(...finite) - Math.min(...finite) < 15) continue;
        const ws = f - fr(3000), we = f + fr(1000);
        if (p.cuts.some((c) => c > ws && c <= we)) continue;
        let covered = 0;
        for (let g = f - fr(1000); g <= f + fr(500); g++) if (byFrame.has(g)) covered++;
        if (covered / (fr(1500) + 1) < 0.7) continue;
        if (f - lastRelease < fr(1000)) continue;
        lastRelease = f;
        const analysis = analyzeSeries(s, track, { taggedReleaseFrame: f, windowStart: ws, windowEnd: we, cuts: p.cuts });
        out.push({ track, releaseFrame: f, timeSec: Number((f / fps).toFixed(2)), hand, analysis });
        break;
      }
    }
  }
  return out.sort((a, b) => a.releaseFrame - b.releaseFrame || a.track - b.track);
}
