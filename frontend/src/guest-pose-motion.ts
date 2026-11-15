import { coordinatesPerFrame, fingerCount, jointCount } from './pose-3d.ts';
import type { Pose, PoseSample } from './pose-3d.ts';
import type { JumpSample } from './shot-grounding.ts';

export type VisionFrame = { index: number; joints: PoseSample[]; fingers?: PoseSample[]; jumpSample?: JumpSample };
type Point = [number, number, number];
type HandSample = { index: number; offset: Point };

const fps = 30;
const releaseIndex = 24;
const frameCount = releaseIndex + fps + 1;
const maxGap = 6;
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

function handOffset(track: HandSample[], index: number): Point | null {
  const previous = track.findLast((sample) => sample.index <= index);
  if (!previous) return null;
  if (previous.index === index) return previous.offset;
  const next = track.find((sample) => sample.index > index);
  if (!next || next.index - previous.index > maxGap) return null;
  return mix(previous.offset, next.offset, (index - previous.index) / (next.index - previous.index));
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
  const hands = new Map<number, (Point | null)[]>();
  const jumpSamples = Array<JumpSample | null>(frameCount).fill(null);
  for (const { index, joints, fingers, jumpSample } of frames) {
    if (!Number.isInteger(index) || index < 0 || index >= frameCount || joints.length !== coordinatesPerFrame) continue;
    const sample = Array.from({ length: jointCount }, (_, joint) => visionPoint(joints, joint));
    if (!sample[pelvis]) continue;
    points.set(index, sample);
    jumpSamples[index] = jumpSample ?? null;
    hands.delete(index);
    if (fingers?.length !== fingerCount * 3) continue;
    hands.set(index, Array.from({ length: fingerCount }, (_, finger) => {
      const point = visionPoint(fingers, finger);
      const wrist = sample[fingerWrist(finger)];
      return point && wrist ? delta(point, wrist) : null;
    }));
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
  const firstFrame = indexes[0]!;
  const lastFrame = indexes.at(-1)!;
  const handTracks = Array.from({ length: fingerCount }, (_, finger) => indexes.flatMap((index): HandSample[] => {
    const offset = hands.get(index)?.[finger];
    return offset ? [{ index, offset }] : [];
  }));
  const fingers = handTracks.some((track) => track.length) ? rows.flatMap((row, index) => {
    // Interpolate short gaps in the wrist's coordinate frame so fingers stay connected to the hand.
    const frame = Math.min(lastFrame, Math.max(firstFrame, index));
    return handTracks.flatMap((track, finger) => {
      const offset = handOffset(track, frame);
      const wrist = row[fingerWrist(finger)];
      const point: Point | null = offset && wrist ? [wrist[0] + offset[0], wrist[1] + offset[1], wrist[2] + offset[2]] : null;
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
    joints: rows.flatMap((row) => row.flatMap((point) => normalize(point, row[pelvis]))),
    fingers,
    jumpSamples: jumpSamples.some(Boolean) ? jumpSamples : undefined,
    pelvisRise: rows.map((row) => row[pelvis] ? number((baseY - row[pelvis]![1]) * scale) : null),
    metrics: {
      releaseElbowDeg: number(angle(release[shoulder], release[elbow], release[wrist])),
      kneeDipDeg: number(Math.min(...dips)),
      releaseHeight: release[head] && release[wrist] ? number((release[head]![1] - release[wrist]![1]) * scale) : null,
    },
  };
}
