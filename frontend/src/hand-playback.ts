import { coordinatesPerFrame, fingerCount, handJoints, jointCount, posePoint, type Pose, type PoseSample } from './pose-3d.ts';

type Point = [number, number, number];
type Track = (Point | null)[];

const offset = (point: Point | null, origin: Point | null): Point | null =>
  point && origin ? [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]] : null;
const add = (point: Point, delta: Point): Point => [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]];
const scale = (point: Point, amount: number): Point => [point[0] * amount, point[1] * amount, point[2] * amount];
const length = (point: Point) => Math.hypot(...point);
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mix = (a: Point, b: Point, t: number): Point =>
  [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];

function smooth(track: Track, radius: number): Track {
  return track.map((center, frame) => {
    if (!center) return null;
    let result = center, weight = radius + 1;
    for (const direction of [-1, 1]) {
      for (let step = 1; step <= radius; step++) {
        const sample = track[Math.max(0, Math.min(track.length - 1, frame + step * direction))];
        if (!sample) break;
        const contribution = radius + 1 - step;
        weight += contribution;
        result = mix(result, sample, contribution / weight);
      }
    }
    return result;
  });
}

function smoothArm(track: Track, radius: number): Track {
  // Averaging the vectors can shorten a bent arm. Use the measured segment length
  // with the smoothed direction so elbows and wrists stay attached.
  const measurements = track.flatMap((point) => point ? [Math.hypot(...point)] : []).filter((length) => length > 1e-6).sort((a, b) => a - b);
  if (!measurements.length) return track;
  const length = measurements[Math.floor(measurements.length / 2)]!;
  return smooth(track, radius).map((point, frame) => {
    if (!point) return null;
    const magnitude = Math.hypot(...point);
    if (magnitude < 1e-6) return track[frame] ?? null;
    const scale = length / magnitude;
    return [point[0] * scale, point[1] * scale, point[2] * scale];
  });
}

function fillFingerGaps(track: Track, maxGap: number, holdFrames: number): Track {
  const observed = track.flatMap((point, frame) => point ? [{ point, frame }] : []);
  let index = 0;
  return track.map((point, frame) => {
    while (index < observed.length && observed[index]!.frame <= frame) index++;
    if (point) return point;
    const before = observed[index - 1], after = observed[index];
    if (before && after && after.frame - before.frame <= maxGap) {
      return mix(before.point, after.point, (frame - before.frame) / (after.frame - before.frame));
    }
    // Keep one adjacent frame from flickering on reacquisition. Longer gaps stay hidden.
    if (before && frame - before.frame <= holdFrames) return before.point;
    if (after && after.frame - frame <= holdFrames) return after.point;
    return null;
  });
}

function write(points: PoseSample[], stride: number, joint: number, frame: number, point: Point | null) {
  const start = stride * frame + joint * 3;
  points[start] = point?.[0] ?? null;
  points[start + 1] = point?.[1] ?? null;
  points[start + 2] = point?.[2] ?? null;
}

function handOffset(point: Point | null, origin: Point | null, minimum: number, maximum: number) {
  const vector = offset(point, origin);
  const size = vector ? length(vector) : 0;
  return size >= minimum && size <= maximum ? vector : null;
}

function preserveWristAnchor(shoulder: Point, elbow: Point, wrist: Point, observed: Point, upper: Point, lower: Point): [Point, Point] {
  const correction = offset(wrist, observed)!;
  const distance = length(correction);
  // A clear hand observation is a positional constraint on the arm smoothing.
  if (distance <= 0.035) return [elbow, wrist];
  const target = add(observed, scale(correction, 0.035 / distance));
  const reach = offset(target, shoulder)!;
  const span = length(reach);
  if (span < 1e-6) return [elbow, target];

  const axis = scale(reach, 1 / span);
  const upperLength = length(upper), lowerLength = length(lower);
  const preferred = offset(elbow, shoulder)!;
  const bend = add(preferred, scale(axis, -dot(preferred, axis)));
  const bendLength = length(bend);
  // Place the elbow on the intersection of the two arm segment spheres.
  const along = Math.min(span, Math.max(0, (upperLength ** 2 - lowerLength ** 2 + span ** 2) / (2 * span)));
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const base = add(shoulder, scale(axis, along));
  return [bendLength > 1e-6 ? add(base, scale(bend, height / bendLength)) : base, target];
}

export function smoothPlayerHands(pose: Pose, lastFrame = pose.frameCount - 1): Pose {
  const last = Math.min(lastFrame, pose.frameCount - 1);
  if (last < 2) return pose;
  const joints = [...pose.joints];
  const fingers = pose.fingers && Array<PoseSample>(pose.frameCount * fingerCount * 3).fill(null);
  const frames = Array.from({ length: last + 1 }, (_, frame) => frame);
  const armRadius = Math.max(1, Math.round(pose.fps / 15));
  const fingerRadius = Math.max(1, Math.round(pose.fps / 10));

  for (const [shoulderJoint, elbowJoint, wristJoint] of [[11, 12, 13], [14, 15, 16]] as const) {
    const shoulders = frames.map((frame) => posePoint(pose, frame, shoulderJoint));
    const elbows = frames.map((frame) => posePoint(pose, frame, elbowJoint));
    const wrists = frames.map((frame) => posePoint(pose, frame, wristJoint));
    const upperArms = smoothArm(elbows.map((elbow, frame) => offset(elbow, shoulders[frame] ?? null)), armRadius);
    const forearms = smoothArm(wrists.map((wrist, frame) => offset(wrist, elbows[frame] ?? null)), armRadius);

    const stableElbows = frames.map((frame) => {
      const shoulder = shoulders[frame], upperArm = upperArms[frame];
      return shoulder && upperArm ? add(shoulder, upperArm) : elbows[frame] ?? null;
    });
    const stableWrists = frames.map((frame) => {
      const elbow = stableElbows[frame], forearm = forearms[frame];
      return elbow && forearm ? add(elbow, forearm) : wrists[frame] ?? null;
    });

    const digits = fingers ? handJoints.filter(([wrist]) => wrist === wristJoint).map(([, knuckle, tip]) => {
      const bases = frames.map((frame) => handOffset(posePoint(pose, frame, knuckle), wrists[frame] ?? null, 0.009, 0.085));
      const tips = frames.map((frame) => {
        const point = posePoint(pose, frame, tip);
        if (!bases[frame] || !handOffset(point, wrists[frame] ?? null, 0.015, 0.135)) return null;
        return handOffset(point, posePoint(pose, frame, knuckle), 0.006, 0.075);
      });
      return { knuckle, tip, bases, tips };
    }) : [];
    for (const frame of frames) {
      const shoulder = shoulders[frame], elbow = stableElbows[frame], wrist = stableWrists[frame], observed = wrists[frame];
      const upper = upperArms[frame], lower = forearms[frame];
      if (shoulder && elbow && wrist && observed && upper && lower && digits.some(({ tips }) => tips[frame])) {
        [stableElbows[frame], stableWrists[frame]] = preserveWristAnchor(shoulder, elbow, wrist, observed, upper, lower);
      }
    }
    for (let frame = 0; frame < pose.frameCount; frame++) {
      const source = Math.min(frame, last);
      write(joints, coordinatesPerFrame, elbowJoint, frame, stableElbows[source] ?? null);
      write(joints, coordinatesPerFrame, wristJoint, frame, stableWrists[source] ?? null);
    }

    if (!fingers) continue;
    for (const { knuckle, tip, bases, tips } of digits) {
      const hold = Math.round(pose.fps / 30);
      const palms = smooth(fillFingerGaps(bases, fingerRadius, hold), fingerRadius);
      const extensions = smooth(fillFingerGaps(tips, fingerRadius, hold), fingerRadius);
      for (let frame = 0; frame < pose.frameCount; frame++) {
        const source = Math.min(frame, last);
        const wrist = stableWrists[source], palm = palms[source], extension = extensions[source];
        const base = wrist && palm ? add(wrist, palm) : null;
        write(fingers, fingerCount * 3, knuckle - jointCount, frame, base);
        write(fingers, fingerCount * 3, tip - jointCount, frame, base && extension ? add(base, extension) : null);
      }
    }
  }
  return { ...pose, joints, fingers };
}
