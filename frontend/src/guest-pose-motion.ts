import { coordinatesPerFrame, fingerCount, jointCount } from './pose-3d.ts';
import type { Pose, PoseSample } from './pose-3d.ts';
import type { JumpSample } from './shot-grounding.ts';

export type VisionFrame = {
  index: number;
  joints: PoseSample[];
  fingers?: PoseSample[];
  fingerOffsets?: PoseSample[];
  jumpSample?: JumpSample;
};
type Point = [number, number, number];

const fps = 30;
const releaseIndex = 24;
const frameCount = releaseIndex + fps + 1;
const maxGap = 6;
const maxHandGap = 4;
const templateHeight = 0.968;
const { pelvis, rightHip, rightKnee, rightAnkle, leftHip, leftKnee, leftAnkle, thorax,
  head, leftShoulder, leftElbow, leftWrist, rightShoulder, rightElbow, rightWrist } = {
  pelvis: 0, rightHip: 1, rightKnee: 2, rightAnkle: 3, leftHip: 4, leftKnee: 5, leftAnkle: 6,
  thorax: 8, head: 10, leftShoulder: 11, leftElbow: 12, leftWrist: 13,
  rightShoulder: 14, rightElbow: 15, rightWrist: 16,
};

const delta = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mix = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const distance = (a?: Point | null, b?: Point | null) => a && b ? Math.hypot(...delta(a, b)) : NaN;
const number = (value: number): PoseSample => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null;
const fingerWrist = (finger: number) => finger % 2 === 0 ? leftWrist : rightWrist;

function visionPoint(samples: PoseSample[], joint: number): Point | null {
  const [x, y, z] = samples.slice(joint * 3, joint * 3 + 3);
  if (x == null || y == null || z == null || ![x, y, z].every(Number.isFinite)) return null;
  return [x, -y, -z];
}

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function direction(point: Point | null | undefined): Point | null {
  const size = point ? Math.hypot(...point) : 0;
  return point && size > 1e-6 ? [point[0] / size, point[1] / size, point[2] / size] : null;
}

function trackedHands(measured: Map<number, (Point | null)[]>, first: number, last: number, height: number) {
  const samples = [...measured.entries()].filter(([frame]) => frame >= first && frame <= last)
    .sort(([a], [b]) => a - b).map(([frame, hand]) => ({ frame, hand: hand.slice() }));
  if (!samples.length) return;

  // A single palm facing away from two nearby observations that agree is likely a mismatched hand.
  for (const side of [0, 1]) {
    const palms = samples.flatMap((sample) => {
      const middle = direction(sample.hand[4 + side]), index = direction(sample.hand[6 + side]);
      const palm = middle && index ? direction(add(middle, index)) : middle ?? index;
      return palm ? [{ ...sample, palm }] : [];
    });
    for (let i = 1; i + 1 < palms.length; i++) {
      const before = palms[i - 1]!, current = palms[i]!, after = palms[i + 1]!;
      if (current.frame - before.frame > 5 || after.frame - current.frame > 5 || dot(before.palm, after.palm) < 0.72) continue;
      const expected = direction(mix(before.palm, after.palm, (current.frame - before.frame) / (after.frame - before.frame)));
      if (!expected || dot(current.palm, expected) >= 0.20) continue;
      for (let point = side; point < fingerCount; point += 2) current.hand[point] = null;
    }
  }

  const rows = Array.from({ length: frameCount }, () => Array<Point | null>(fingerCount).fill(null));
  for (const { frame, hand } of samples) rows[frame] = hand.slice();
  for (let tip = 0; tip < 4; tip++) {
    const knuckle = tip + 4;
    const valid = samples.filter(({ hand }) => hand[tip] && hand[knuckle]);
    for (let i = 1; i < valid.length; i++) {
      const from = valid[i - 1]!, to = valid[i]!;
      const gap = to.frame - from.frame;
      if (gap < 2 || gap > maxHandGap) continue;
      const a = from.hand[tip]!, b = to.hand[tip]!, baseA = from.hand[knuckle]!, baseB = to.hand[knuckle]!;
      const dirA = direction(baseA), dirB = direction(baseB);
      if (!dirA || !dirB || dot(dirA, dirB) < 0.5 || distance(a, b) > 0.075 * height) continue;
      for (let frame = from.frame + 1; frame < to.frame; frame++) {
        const hand = rows[frame]!;
        const t = (frame - from.frame) / gap;
        const base = mix(baseA, baseB, t);
        // Use the observed knuckle if it agrees with the nearby hand. Keep a real turn intact.
        if (hand[knuckle] && distance(hand[knuckle], base) > 0.025 * height) continue;
        hand[knuckle] ??= base;
        hand[tip] ??= mix(a, b, t);
      }
    }
  }
  return rows;
}

function angle(a?: Point | null, b?: Point | null, c?: Point | null) {
  if (!a || !b || !c) return NaN;
  const u = delta(a, b), v = delta(c, b);
  const length = Math.hypot(...u) * Math.hypot(...v);
  if (!length) return NaN;
  const cosine = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / length;
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
}

/** Align the actual Vision detections to the same release time and body frame as NBA references. */
export function guestPoseFromVision(frames: VisionFrame[]): Pose {
  const points = new Map<number, (Point | null)[]>();
  const measuredHands = new Map<number, (Point | null)[]>();
  const jumpSamples = Array<JumpSample | null>(frameCount).fill(null);
  for (const { index, joints, fingers, fingerOffsets, jumpSample } of frames) {
    if (!Number.isInteger(index) || index < 0 || index >= frameCount) continue;
    if (fingerOffsets?.length === fingerCount * 3) {
      measuredHands.set(index, Array.from({ length: fingerCount }, (_, finger) => visionPoint(fingerOffsets, finger)));
    }
    if (joints.length !== coordinatesPerFrame) continue;
    const sample = Array.from({ length: jointCount }, (_, joint) => visionPoint(joints, joint));
    if (!sample[pelvis]) continue;
    points.set(index, sample);
    jumpSamples[index] = jumpSample ?? null;
    if (fingers?.length === fingerCount * 3) {
      measuredHands.set(index, Array.from({ length: fingerCount }, (_, finger) => {
        const point = visionPoint(fingers, finger);
        const wrist = sample[fingerWrist(finger)];
        return point && wrist ? delta(point, wrist) : null;
      }));
    }
  }
  const indexes = [...points.keys()].sort((a, b) => a - b);
  const atRelease = indexes.filter((index) => Math.abs(index - releaseIndex) <= 4);
  if (indexes.length < 3 || !atRelease.length) throw new Error('No clear body pose near this release. Choose the release frame in a clip with the shooter in view.');

  let dx = 0, dz = 0;
  for (const index of atRelease) {
    const sample = points.get(index)!;
    for (const [left, right] of [[leftShoulder, rightShoulder], [leftHip, rightHip]] as const) {
      const a = sample[left], b = sample[right];
      if (a && b) {
        dx += a[0] - b[0];
        dz += a[2] - b[2];
      }
    }
  }
  const width = Math.hypot(dx, dz);
  const heights = [...points.values()].map((p) => {
    const legs = (distance(p[rightHip], p[rightKnee]) + distance(p[rightKnee], p[rightAnkle])
      + distance(p[leftHip], p[leftKnee]) + distance(p[leftKnee], p[leftAnkle])) / 2;
    return distance(p[head], p[thorax]) + distance(p[thorax], p[pelvis]) + legs;
  }).filter((height) => Number.isFinite(height) && height > 0).sort((a, b) => a - b);
  const height = heights[Math.floor(heights.length / 2)];
  if (!height || width < 0.01) throw new Error('Keep the shooter’s full body in frame near release so Peek can align the two motions.');
  const scale = templateHeight / height;
  const cos = dx / width, sin = dz / width;
  const normalize = (point?: Point | null, root?: Point | null): PoseSample[] => {
    if (!point || !root) return [null, null, null];
    const [x, y, z] = delta(point, root);
    return [number((cos * x + sin * z) * scale), number(y * scale), number((-sin * x + cos * z) * scale)];
  };

  const rows = Array.from({ length: frameCount }, (_, index) => {
    const exact = points.get(index);
    if (exact) return exact;
    const before = indexes.findLast((frame) => frame < index);
    const after = indexes.find((frame) => frame > index);
    // Keep a real end pose visible when a clip starts or ends inside the comparison window.
    if (before === undefined || after === undefined) return points.get((before ?? after)!)!;
    if (after - before > maxGap) return Array<Point | null>(jointCount).fill(null);
    const t = (index - before) / (after - before);
    const next = points.get(after)!;
    return points.get(before)!.map((a, joint): Point | null => {
      const b = next[joint];
      return a && b ? mix(a, b, t) : null;
    });
  });
  const firstBodyFrame = indexes[0]!;
  const lastBodyFrame = indexes.at(-1)!;
  const handOffsets = trackedHands(measuredHands, firstBodyFrame, lastBodyFrame, height);
  const fingers = handOffsets ? rows.flatMap((row, index) => {
    const offsets = handOffsets[index]!;
    return offsets.flatMap((offset, finger) => {
      const wrist = row[fingerWrist(finger)];
      // A fingertip is drawn only with its own observed or briefly bridged knuckle.
      const point = offset && wrist && (finger >= 4 || offsets[finger + 4]) ? add(wrist, offset) : null;
      return normalize(point, row[pelvis]);
    });
  }) : undefined;
  const release = rows[releaseIndex]!;
  if (!release[pelvis] || !(release[leftWrist] || release[rightWrist])) {
    throw new Error('The shooting arm could not be tracked at release. Check the tag and choose a clearer view.');
  }
  const wristHeight = (wrist: number) => {
    const heights = rows.slice(releaseIndex, releaseIndex + 7).flatMap((row) => row[wrist] ? [row[wrist]![1]] : []);
    return heights.length ? heights.reduce((sum, y) => sum + y, 0) / heights.length : Infinity;
  };
  const right = wristHeight(rightWrist) <= wristHeight(leftWrist);
  const [shoulder, elbow, wrist] = right ? [rightShoulder, rightElbow, rightWrist] : [leftShoulder, leftElbow, leftWrist];
  const dips = rows.slice(0, releaseIndex + 1).map((row) => {
    const knees = [angle(row[rightHip], row[rightKnee], row[rightAnkle]), angle(row[leftHip], row[leftKnee], row[leftAnkle])]
      .filter(Number.isFinite);
    return knees.length ? knees.reduce((sum, bend) => sum + bend, 0) / knees.length : Infinity;
  });
  const baseY = rows[0]![pelvis]?.[1] ?? release[pelvis]![1];
  return {
    fps, releaseIndex, frameCount, shootingHand: right ? 'right' : 'left',
    jumpSamples: jumpSamples.some(Boolean) ? jumpSamples : undefined,
    joints: rows.flatMap((row) => row.flatMap((point) => normalize(point, row[pelvis]))),
    fingers: fingers?.some((coordinate) => coordinate !== null) ? fingers : undefined,
    pelvisRise: rows.map((row) => row[pelvis] ? number((baseY - row[pelvis]![1]) * scale) : null),
    metrics: {
      releaseElbowDeg: number(angle(release[shoulder], release[elbow], release[wrist])),
      kneeDipDeg: number(Math.min(...dips)),
      releaseHeight: release[head] && release[wrist] ? number((release[head]![1] - release[wrist]![1]) * scale) : null,
    },
  };
}
