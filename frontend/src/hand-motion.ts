import type { Pose, PoseSample } from './pose-3d.ts';

type Point = [number, number, number];
type Track = (Point | null)[];
type FingerChain = readonly [wrist: number, knuckle: number, tip: number];

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Point, n: number): Point => [a[0] * n, a[1] * n, a[2] * n];
const length = (a: Point) => Math.hypot(...a);
const distance = (a: Point, b: Point) => length(subtract(a, b));
const mix = (a: Point, b: Point, t: number) => add(a, scale(subtract(b, a), t));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function point(samples: PoseSample[], frame: number, stride: number, joint: number): Point | null {
  if (joint < 0 || joint * 3 + 2 >= stride) return null;
  const offset = frame * stride + joint * 3;
  const x = samples[offset], y = samples[offset + 1], z = samples[offset + 2];
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) &&
    typeof z === 'number' && Number.isFinite(z) ? [x, y, z] : null;
}

function write(samples: PoseSample[], frame: number, stride: number, joint: number, value: Point | null) {
  const offset = frame * stride + joint * 3;
  samples[offset] = value?.[0] ?? null;
  samples[offset + 1] = value?.[1] ?? null;
  samples[offset + 2] = value?.[2] ?? null;
}

function medianLength(track: Track, minimum: number, maximum: number) {
  const values = track.flatMap((vector) => vector ? [length(vector)] : [])
    .filter((value) => value >= minimum && value <= maximum).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length < 3 ? null : (values[middle]! + values[Math.floor((values.length - 1) / 2)]!) / 2;
}

function localTrack(points: Track, origins: Track): Track {
  return points.map((value, frame) => value && origins[frame] ? subtract(value, origins[frame]!) : null);
}

function smoothWrists(wrists: Track, elbows: Track, fps: number): Track {
  const forearms = localTrack(wrists, elbows);
  const shaft = medianLength(forearms, 0.062, 0.24);
  if (shaft === null) return wrists;
  const radius = Math.max(1, Math.round(fps * 0.13));
  let last = wrists.length - 1;
  while (last > 0) {
    const current = forearms[last], previous = forearms[last - 1];
    if (!current || !previous || distance(current, previous) > 1e-9) break;
    last--;
  }
  return wrists.map((wrist, frame) => {
    const elbow = elbows[frame], forearm = forearms[frame];
    if (!wrist || !elbow || !forearm || frame >= last) return wrist;
    const rawLength = length(forearm);
    const support = Math.min(radius, frame, last - frame);
    let direction: Point = [0, 0, 0];
    for (let step = -support; step <= support; step++) {
      const neighbor = forearms[frame + step];
      if (!neighbor) continue;
      const size = length(neighbor);
      if (size < 0.03) continue;
      const confidence = Math.min(size / shaft, shaft / size, 1) ** 2;
      direction = add(direction, scale(neighbor, (support + 1 - Math.abs(step)) * confidence / size));
    }
    const directionSize = length(direction);
    if (directionSize < 1e-5) return wrist;
    // The elbow stays fixed. Stronger corrections are reserved for clearly stretched or shortened forearms.
    const targetLength = clamp(rawLength, shaft * 0.88, shaft * 1.12);
    const correction = subtract(scale(direction, targetLength / directionSize), forearm);
    const maximumCorrection = 0.024 + Math.min(0.028, Math.abs(targetLength - rawLength));
    const correctionSize = length(correction);
    return add(wrist, scale(correction, Math.min(1, maximumCorrection / Math.max(correctionSize, 1e-9))));
  });
}

function neighbors(track: Track, frame: number, step: -1 | 1, limit: number) {
  for (let offset = 1; offset <= limit; offset++) {
    if (track[frame + step * offset]) return frame + step * offset;
  }
  return null;
}

function rejectSpikes(track: Track, turn: number, support: number): Track {
  return track.map((value, frame) => {
    if (!value) return null;
    const prior = neighbors(track, frame, -1, support);
    const next = neighbors(track, frame, 1, support);
    if (prior !== null && next !== null) {
      const a = track[prior]!, b = track[next]!;
      const midpoint = mix(a, b, (frame - prior) / (next - prior));
      return distance(a, b) < turn * 0.72 && distance(value, midpoint) > turn ? null : value;
    }
    // A stray first or last detection should agree with at least one of two corroborating samples.
    const nearest = prior ?? next;
    if (nearest === null) return value;
    const farther = neighbors(track, nearest, prior === null ? 1 : -1, support);
    if (farther === null) return value;
    const a = track[nearest]!, b = track[farther]!;
    return distance(a, b) < turn * 0.55 && Math.min(distance(value, a), distance(value, b)) > turn ? null : value;
  });
}

function fillGaps(track: Track, maximumGap: number, speed: number,
  allow: (frame: number, prior: number, next: number) => boolean): Track {
  return track.map((value, frame) => {
    if (value) return value;
    const prior = neighbors(track, frame, -1, maximumGap);
    const next = neighbors(track, frame, 1, maximumGap);
    if (prior === null || next === null || next - prior > maximumGap + 1 || !allow(frame, prior, next)) return null;
    const a = track[prior]!, b = track[next]!;
    // Do not interpolate opposing directions through a folded, nearly zero-length link.
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return dot > 0.3 * length(a) * length(b) && distance(a, b) <= speed * (next - prior)
      ? mix(a, b, (frame - prior) / (next - prior)) : null;
  });
}

function smoothLocal(track: Track, radius: number): Track {
  return track.map((value, frame) => {
    if (!value) return null;
    let offset: Point = [0, 0, 0];
    let total = radius + 1;
    for (let step = 1; step <= radius; step++) {
      const before = track[frame - step], after = track[frame + step];
      if (!before || !after) break;
      const weight = radius + 1 - step;
      offset = add(offset, scale(add(subtract(before, value), subtract(after, value)), weight));
      total += 2 * weight;
    }
    return add(value, scale(offset, 1 / total));
  });
}

function plausibleLength(vector: Point | null, median: number | null, low: number, high: number,
  minimum: number, maximum: number): Point | null {
  if (!vector) return null;
  const size = length(vector);
  const min = Math.max(minimum, median === null ? minimum : median * low);
  const max = Math.min(maximum, median === null ? maximum : median * high);
  return size >= min && size <= max ? vector : null;
}

function limitLength(vector: Point, median: number | null, low: number, high: number): Point | null {
  if (median === null) return vector;
  const size = length(vector);
  if (size < median * 0.24) return null;
  return scale(vector, clamp(size, median * low, median * high) / size);
}

/** Stabilize the measured user hands. Positions are in body-height units. */
export function stabilizeHandMotion(pose: Pose, chains: readonly FingerChain[]): Pose {
  if (!pose.frameCount) return pose;
  const bodyStride = pose.joints.length / pose.frameCount;
  const fingers = pose.fingers?.slice();
  const fingerStride = (fingers?.length ?? 0) / pose.frameCount;
  if (!Number.isInteger(bodyStride / 3) || !Number.isInteger(fingerStride / 3)) return pose;
  const frames = Array.from({ length: pose.frameCount }, (_, frame) => frame);
  const joints = pose.joints.slice();
  const wristTracks = new Map<number, Track>();
  const correctedWrists = new Map<number, Track>();
  for (const [wrist] of chains) {
    if (wristTracks.has(wrist)) continue;
    const wrists = frames.map((frame) => point(pose.joints, frame, bodyStride, wrist));
    const elbows = frames.map((frame) => point(pose.joints, frame, bodyStride, wrist - 1));
    const corrected = smoothWrists(wrists, elbows, pose.fps);
    wristTracks.set(wrist, wrists);
    correctedWrists.set(wrist, corrected);
    corrected.forEach((value, frame) => {
      if (value) write(joints, frame, bodyStride, wrist, value);
    });
  }
  if (!fingers) return { ...pose, joints };

  // Limit interpolation to brief internal gaps with reliable geometry at both ends.
  const bodyCount = bodyStride / 3;
  const maxGap = Math.max(1, Math.round(pose.fps * 0.065));
  const radius = Math.max(1, Math.round(pose.fps * 0.065));
  const neighborSpeed = 30 / pose.fps;
  const fingerTrack = (joint: number) => frames.map((frame) => point(fingers, frame, fingerStride, joint - bodyCount));
  for (const [wrist, knuckle, tip] of chains) {
    const wristTrack = wristTracks.get(wrist);
    const targetWrist = correctedWrists.get(wrist);
    if (!wristTrack || !targetWrist) continue;
    const hasKnuckle = knuckle >= bodyCount && (knuckle - bodyCount) * 3 < fingerStride;
    const hasTip = tip >= bodyCount && (tip - bodyCount) * 3 < fingerStride;
    const observedKnuckles = fingerTrack(knuckle);
    const observedPalms = localTrack(observedKnuckles, wristTrack);
    const observedFingers = localTrack(fingerTrack(tip), observedKnuckles);
    const palmLength = medianLength(observedPalms, 0.016, 0.1);
    const fingerLength = medianLength(observedFingers, 0.007, 0.12);
    const palms = rejectSpikes(observedPalms.map((value) => plausibleLength(value, palmLength, 0.55, 1.65, 0.016, 0.1)),
      0.050, maxGap);
    const digits = rejectSpikes(observedFingers.map((value, frame) =>
      palms[frame] ? plausibleLength(value, fingerLength, 0.30, 1.8, 0.005, 0.12) : null), 0.052, maxGap);
    const filteredPalms = smoothLocal(fillGaps(palms, maxGap, 0.025 * neighborSpeed, (frame) => !!wristTrack[frame]), radius);
    const filledDigits = fillGaps(digits, maxGap, 0.026 * neighborSpeed, (frame, prior, next) => {
      const palm = filteredPalms[frame];
      return !!palm && distance(palm, mix(palms[prior]!, palms[next]!, (frame - prior) / (next - prior))) < 0.025;
    });
    const filteredDigits = smoothLocal(filledDigits, radius);

    for (const frame of frames) {
      const origin = targetWrist[frame], palm = filteredPalms[frame], finger = filteredDigits[frame];
      const palmOffset = palm && limitLength(palm, palmLength, 0.83, 1.17);
      // The knuckle-to-tip chord can shorten as a finger bends, so leave a wider range of motion.
      const fingerOffset = finger && limitLength(finger, fingerLength, 0.58, 1.5);
      const targetKnuckle = origin && palmOffset ? add(origin, palmOffset) : null;
      if (hasKnuckle) write(fingers, frame, fingerStride, knuckle - bodyCount, targetKnuckle);
      if (hasTip) write(fingers, frame, fingerStride, tip - bodyCount,
        targetKnuckle && fingerOffset ? add(targetKnuckle, fingerOffset) : null);
    }
  }
  return { ...pose, joints, fingers };
}
