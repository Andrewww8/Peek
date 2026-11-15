import { buildUsdz } from '../../mobile/src/core/usdz.ts';
import { jumpClearance, type JumpSample } from './shot-grounding.ts';

export type PoseSample = number | null;
export type Pose = {
  fps: number;
  releaseIndex: number;
  frameCount: number;
  shootingHand: 'right' | 'left';
  joints: PoseSample[];
  fingers?: PoseSample[] | null;
  jumpSamples?: (JumpSample | null)[];
  pelvisRise: PoseSample[] | null;
  metrics: { releaseElbowDeg: PoseSample; kneeDipDeg: PoseSample; releaseHeight: PoseSample };
};

export const jointCount = 17;
export const coordinatesPerFrame = jointCount * 3;
export const legacyFingerCount = 6;
export const fingerCount = 8;
export const posePointCount = jointCount + fingerCount;
export const handJoints = [[13, 21, 17], [16, 22, 18], [13, 23, 19], [16, 24, 20]] as const;
export const bones = [
  [0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6],
  [0, 7], [7, 8], [8, 9], [9, 10], [8, 11], [11, 12], [12, 13], [8, 14], [14, 15], [15, 16],
  [13, 21], [16, 22], [21, 17], [22, 18], [13, 23], [16, 24], [23, 19], [24, 20],
] as const;

function poseFingerCount(pose: Pose): number {
  if (pose.fingers?.length === pose.frameCount * fingerCount * 3) return fingerCount;
  if (pose.fingers?.length === pose.frameCount * legacyFingerCount * 3) return legacyFingerCount;
  return 0;
}

export function shotMotionWindow(pose: Pose): [first: number, last: number] {
  const fingerWidth = poseFingerCount(pose) * 3;
  const sameFrame = (a: number, b: number) => {
    if ((pose.pelvisRise?.[a] ?? 0) !== (pose.pelvisRise?.[b] ?? 0)) return false;
    for (let coordinate = 0; coordinate < coordinatesPerFrame; coordinate++) {
      if (pose.joints[a * coordinatesPerFrame + coordinate] !== pose.joints[b * coordinatesPerFrame + coordinate]) return false;
    }
    for (let coordinate = 0; coordinate < fingerWidth; coordinate++) {
      if (pose.fingers?.[a * fingerWidth + coordinate] !== pose.fingers?.[b * fingerWidth + coordinate]) return false;
    }
    return true;
  };
  let first = 0;
  let last = pose.frameCount - 1;
  // Repeated end poses fill parts of the reference timeline for which the clip has no detections.
  while (first < pose.releaseIndex && sameFrame(first, first + 1)) first++;
  while (last > pose.releaseIndex && sameFrame(last - 1, last)) last--;
  return [first, last];
}

export function comparisonPlayback(pose: Pose, first = 0): Pose {
  const frameCount = pose.releaseIndex + pose.fps - first + 1;
  const handCount = poseFingerCount(pose);
  const visible = Array.from({ length: Math.min(frameCount, Math.max(0, pose.frameCount - first)) }, (_, i) => first + i)
    .filter((frame) => bones.some(([a, b]) => b < jointCount && posePoint(pose, frame, a) && posePoint(pose, frame, b)));
  let next = 0;
  const frames = Array.from({ length: frameCount }, (_, i): [number, number, number] => {
    const frame = first + i;
    while (next < visible.length && visible[next]! <= frame) next++;
    const before = visible[next - 1];
    const after = visible[next];
    if (before === undefined || before === frame) return [frame, frame, 0];
    // Bridge gaps between measured poses instead of freezing at release and jumping on reacquisition.
    if (after !== undefined) return [before, after, (frame - before) / (after - before)];
    // After the final measured pose, keep it on screen while the comparison finishes.
    return [before, before, 0];
  });
  const samples = (values: PoseSample[], width: number) => frames.flatMap(([before, after, fraction]) =>
    Array.from({ length: width }, (_, i) => {
      const start = values[before * width + i] ?? null;
      if (before === after) return start;
      const end = values[after * width + i] ?? null;
      return start !== null && end !== null ? start + (end - start) * fraction : null;
    }),
  );
  const fingers = !pose.fingers || !handCount ? undefined : handCount === fingerCount
    ? Array.from({ length: frameCount * fingerCount * 3 }, (_, index) => pose.fingers?.[first * fingerCount * 3 + index] ?? null)
    : samples(pose.fingers, handCount * 3);
  return {
    ...pose,
    frameCount,
    releaseIndex: pose.releaseIndex - first,
    joints: samples(pose.joints, coordinatesPerFrame),
    fingers,
    jumpSamples: Array.isArray(pose.jumpSamples) ? pose.jumpSamples.slice(first, first + frameCount) : undefined,
    pelvisRise: pose.pelvisRise && samples(pose.pelvisRise, 1),
  };
}

export function groundedShotPlayback(source: Pose, first: number): Pose {
  return groundPlayback(comparisonPlayback(source, first), source, first);
}

export function stabilizedShotPlayback(source: Pose, first: number): Pose {
  const pose = comparisonPlayback(source, first);
  const [, last] = shotMotionWindow(source);
  const lastFrame = Math.min(pose.frameCount - 1, last - first);
  const radius = Math.max(1, Math.round(pose.fps * 0.1));
  const joints = pose.joints.slice();
  for (let frame = 1; frame < lastFrame; frame++) {
    const support = Math.min(radius, frame, lastFrame - frame);
    const start = frame * coordinatesPerFrame;
    // The shared centered window attenuates brief pose spikes without shifting the release
    // or carrying a filtered value into the final measured pose.
    for (let coordinate = 0; coordinate < coordinatesPerFrame; coordinate++) {
      const center = pose.joints[start + coordinate];
      if (center == null) continue;
      let change = 0, weight = support + 1;
      for (let step = 1; step <= support; step++) {
        const before = pose.joints[start - step * coordinatesPerFrame + coordinate];
        const after = pose.joints[start + step * coordinatesPerFrame + coordinate];
        if (before == null || after == null) break;
        const contribution = support + 1 - step;
        change += ((before - center) + (after - center)) * contribution;
        weight += 2 * contribution;
      }
      joints[start + coordinate] = center + change / weight;
    }
  }
  const fingerWidth = poseFingerCount(pose) * 3;
  const fingers = pose.fingers?.map((value, index) => {
    if (value === null || !fingerWidth) return value;
    // Follow the body wrist with the same translation for every measured point on its hand.
    const wrist = Math.floor(index / 3) % 2 === 0 ? 13 : 16;
    const coordinate = Math.floor(index / fingerWidth) * coordinatesPerFrame + wrist * 3 + index % 3;
    const before = pose.joints[coordinate], after = joints[coordinate];
    return before == null || after == null ? null : value + (after - before);
  });
  return groundPlayback({ ...pose, joints, fingers }, source, first);
}

function groundPlayback(pose: Pose, source: Pose, first: number): Pose {
  const samples = Array.isArray(source.jumpSamples) ? source.jumpSamples : [];
  const clearance = jumpClearance(samples, source.frameCount, source.releaseIndex, source.fps);
  const [, lastPose] = shotMotionWindow(source);
  const lastTrackedFoot = samples.reduce((last, sample, frame) =>
    Number.isFinite(sample?.[0]) && Number.isFinite(sample?.[1]) ? frame : last, -1);
  const last = Math.max(lastPose, lastTrackedFoot);
  const ankles = Array.from({ length: pose.frameCount }, (_, frame) => {
    const right = posePoint(pose, frame, 3)?.[1], left = posePoint(pose, frame, 6)?.[1];
    return right === undefined ? left : left === undefined ? right : Math.max(right, left);
  });
  if (ankles.every((ankle) => ankle === undefined)) return pose;

  // Move the whole skeleton to the supporting ankle. This keeps knee and hand motion intact.
  const floor = 0.55;
  let previous = -1;
  let next = ankles.findIndex((ankle) => ankle !== undefined);
  const pelvisRise = ankles.map((ankle, frame) => {
    let support = ankle;
    if (ankle !== undefined) {
      previous = frame;
      next = ankles.findIndex((value, index) => index > frame && value !== undefined);
    } else if (previous === -1) {
      support = ankles[next]!;
    } else if (next === -1) {
      support = ankles[previous]!;
    } else {
      const before = ankles[previous]!, after = ankles[next]!;
      support = before + (after - before) * (frame - previous) / (next - previous);
    }
    return support! - floor + (clearance[Math.min(first + frame, last)] ?? 0);
  });
  return { ...pose, pelvisRise };
}

type Vector = [number, number, number];
type Rotation = [number, number, number, number];

export type NameAtlas = {
  cell: number;
  columns: number;
  rows: number;
  baseline: number;
  advances: Record<string, [number, number]>;
};

export type ComparisonLabels = {
  atlas: NameAtlas;
  png: Uint8Array;
  player: string;
  reference: string;
};

export function poseGround(pose: Pose) {
  let bottom = -Infinity;
  for (let i = 0; i < pose.frameCount; i++) {
    for (const ankle of [3, 6]) {
      const y = pose.joints[i * coordinatesPerFrame + ankle * 3 + 1];
      if (y != null) bottom = Math.max(bottom, y - (pose.pelvisRise?.[i] ?? 0));
    }
  }
  return Number.isFinite(bottom) ? bottom : 0.55;
}

export function posePoint(pose: Pose, frame: number, joint: number): Vector | null {
  const finger = joint >= jointCount;
  const values = finger ? pose.fingers : pose.joints;
  const count = finger ? poseFingerCount(pose) : jointCount;
  const slot = finger ? joint - jointCount : joint;
  if (slot >= count) return null;
  const index = (frame * count + slot) * 3;
  const x = values?.[index], y = values?.[index + 1], z = values?.[index + 2];
  return x == null || y == null || z == null ? null : [x, y, z];
}

export function visiblePosePoint(pose: Pose, frame: number, joint: number): Vector | null {
  if (joint >= jointCount) {
    const chain = handJoints.find(([, knuckle, tip]) => joint === knuckle || joint === tip);
    if (!chain || !posePoint(pose, frame, chain[0]) || (joint === chain[2] && !posePoint(pose, frame, chain[1]))) return null;
  }
  return posePoint(pose, frame, joint);
}

function anchor(pose: Pose, frame: number, joint: number, ground: number, offset: number): Vector | null {
  const point = visiblePosePoint(pose, frame, joint);
  if (!point) return null;
  const [x, y, z] = point;
  const heightInMeters = 1.75;
  return [
    x * heightInMeters + offset,
    (ground + (pose.pelvisRise?.[frame] ?? 0) - y) * heightInMeters,
    -z * heightInMeters,
  ];
}

function midpoint(a: Vector, b: Vector): Vector {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function boneRotation(dx: number, dy: number, dz: number, length: number): Rotation {
  const w = 1 + dy / length;
  const x = dz / length;
  const z = -dx / length;
  const norm = Math.hypot(w, x, z);
  return norm > 1e-6 ? [w / norm, x / norm, 0, z / norm] : [0, 1, 0, 0];
}

function tuple(elements: readonly number[]) {
  return '(' + elements.map((value) => value.toFixed(5)).join(', ') + ')';
}

function track(type: string, op: string, frames: readonly (readonly number[] | null)[], fallback: readonly number[]) {
  const initial = frames.find((value) => value !== null) ?? fallback;
  const samples = frames.map((value, index) => String(index) + ': ' + tuple(value ?? initial)).join(',\n');
  return type + ' xformOp:' + op + ' = ' + tuple(initial)
    + '\n' + type + ' xformOp:' + op + '.timeSamples = {\n' + samples + '\n}';
}

function visibility(frames: readonly (unknown | null)[]) {
  if (!frames.includes(null)) return '';
  return 'token visibility.timeSamples = {\n' + frames.map((value, frame) =>
    String(frame) + ': "' + (value === null ? 'invisible' : 'inherited') + '"').join(',\n') + '\n}';
}

function actor(id: string, pose: Pose, offset: number, tint: Vector) {
  const ground = poseGround(pose);
  const frames = Array.from({ length: pose.frameCount }, (_, frame) =>
    Array.from({ length: posePointCount }, (_, joint) => anchor(pose, frame, joint, ground, offset)),
  );
  const color = 'color3f[] primvars:displayColor = [' + tuple(tint) + ']';
  const parts = ['def Xform "' + id + '" {'];
  const hiddenScale = [0.0001, 0.0001, 0.0001];
  for (let joint = 0; joint < posePointCount; joint++) {
    const positions = frames.map((sample) => sample[joint] ?? null);
    if (!positions.some(Boolean)) continue;
    const finger = joint >= jointCount;
    const sparse = finger && positions.includes(null);
    parts.push('def Sphere "' + (finger ? 'Finger_' + String(joint - jointCount) : 'Joint_' + String(joint)) + '" {',
      'double radius = ' + (finger ? '0.013' : joint === 10 ? '0.056' : '0.027'), color,
      track('double3', 'translate', positions, [offset, 0, 0]), visibility(positions),
      ...(sparse ? [track('float3', 'scale', positions.map((position) => position ? [1, 1, 1] : hiddenScale), [1, 1, 1])] : []),
      'uniform token[] xformOpOrder = ["xformOp:translate"' + (sparse ? ', "xformOp:scale"' : '') + ']', '}');
  }
  for (const [from, to] of bones) {
    let previous: Rotation | undefined;
    const data = frames.map((sample) => {
      const a = sample[from], b = sample[to];
      if (!a || !b) return null;
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const length = Math.hypot(dx, dy, dz);
      if (length < 1e-5) return null;
      let rotation = boneRotation(dx, dy, dz, length);
      if (previous && previous.reduce((dot, component, index) => dot + component * rotation[index]!, 0) < 0) {
        rotation = [-rotation[0], -rotation[1], -rotation[2], -rotation[3]];
      }
      previous = rotation;
      return { center: midpoint(a, b), rotation, scale: [1, length / 2, 1] };
    });
    if (!data.some(Boolean)) continue;
    const missingScale = to >= jointCount ? hiddenScale : null;
    parts.push('def Cylinder "Bone_' + String(from) + '_' + String(to) + '" {',
      'uniform token axis = "Y"', 'double radius = ' + (to >= jointCount ? '0.007' : '0.016'), 'double height = 2', color,
      track('double3', 'translate', data.map((item) => item?.center ?? null), [offset, 0, 0]),
      track('quatf', 'orient', data.map((item) => item?.rotation ?? null), [1, 0, 0, 0]),
      track('float3', 'scale', data.map((item) => item?.scale ?? missingScale), [1, 0, 1]), visibility(data),
      'uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]', '}');
  }
  parts.push('}');
  return parts.join('\n');
}

function nameMaterial(name: string, color: Vector) {
  const path = '/PeekComparison/NameMaterials/' + name;
  return [
    'def Material "' + name + '" {',
    'token outputs:surface.connect = <' + path + '/Surface.outputs:surface>',
    'def Shader "Surface" {',
    'uniform token info:id = "UsdPreviewSurface"',
    'color3f inputs:diffuseColor = ' + tuple(color),
    'color3f inputs:emissiveColor = ' + tuple(color.map((channel) => channel * 0.28)),
    'float inputs:roughness = 0.8',
    'float inputs:opacity.connect = <' + path + '/Atlas.outputs:a>',
    'float inputs:opacityThreshold = 0.35',
    'token outputs:surface', '}',
    'def Shader "Atlas" {',
    'uniform token info:id = "UsdUVTexture"',
    'asset inputs:file = @NameAtlas.png@',
    'float2 inputs:st.connect = <' + path + '/UV.outputs:result>',
    'token inputs:wrapS = "clamp"',
    'token inputs:wrapT = "clamp"',
    'float outputs:a', '}',
    'def Shader "UV" {',
    'uniform token info:id = "UsdPrimvarReader_float2"',
    'string inputs:varname = "st"',
    'float2 outputs:result', '}', '}',
  ].join('\n');
}

function nameMesh(id: string, name: string, offset: number, material: string, atlas: NameAtlas) {
  const { cell, columns, rows, baseline, advances } = atlas;
  const characters = Array.from(name.trim().replace(/\s+/g, ' ')).slice(0, 48);
  const totalWidth = characters.reduce((sum, char) => sum + (advances[char] ?? advances['?']!)[1], 0);
  const meterPerPixel = Math.min(0.0036, 1.04 / Math.max(1, totalWidth));
  const low = 2.07 - (cell - baseline) * meterPerPixel;
  const high = 2.07 + baseline * meterPerPixel;
  let position = offset - totalWidth * meterPerPixel / 2;
  const points: string[] = [];
  const uv: string[] = [];
  for (const char of characters) {
    const [index, advance] = advances[char] ?? advances['?']!;
    if (char !== ' ') {
      const left = position - 2 * meterPerPixel;
      const right = left + cell * meterPerPixel;
      const u = (index % columns) / columns;
      const v = 1 - Math.floor(index / columns) / rows;
      points.push(tuple([left, low, 0]), tuple([right, low, 0]), tuple([right, high, 0]), tuple([left, high, 0]));
      uv.push(tuple([u, v - 1 / rows]), tuple([u + 1 / columns, v - 1 / rows]),
        tuple([u + 1 / columns, v]), tuple([u, v]));
    }
    position += advance * meterPerPixel;
  }
  return [
    'def Mesh "' + id + '" ( prepend apiSchemas = ["MaterialBindingAPI"] ) {',
    'custom string peek:name = ' + JSON.stringify(characters.join('')),
    'bool doubleSided = true', 'uniform token subdivisionScheme = "none"',
    'point3f[] points = [' + points.join(', ') + ']',
    'int[] faceVertexCounts = [' + Array.from({ length: points.length / 4 }, () => 4).join(', ') + ']',
    'int[] faceVertexIndices = [' + points.map((_, index) => index).join(', ') + ']',
    'texCoord2f[] primvars:st = [' + uv.join(', ') + '] ( interpolation = "vertex" )',
    'rel material:binding = </PeekComparison/NameMaterials/' + material + '>', '}',
  ].join('\n');
}

export function comparisonUsdz(player: Pose, reference: Pose, labels?: ComparisonLabels) {
  if (player.fps !== reference.fps || player.releaseIndex !== reference.releaseIndex) {
    throw new Error('The two shots must use the same release timeline.');
  }
  const playerPlayback = comparisonPlayback(player);
  const referencePlayback = comparisonPlayback(reference);
  const fps = String(player.fps / 2);
  const white: Vector = [1, 1, 1];
  const yellow: Vector = [1, 0.79, 0.04];
  const text = [
    '#usda 1.0', '(',
    'defaultPrim = "PeekComparison"', 'metersPerUnit = 1', 'upAxis = "Y"',
    'startTimeCode = 0', 'endTimeCode = ' + String(playerPlayback.frameCount - 1),
    'timeCodesPerSecond = ' + fps, 'framesPerSecond = ' + fps, ')',
    'def Xform "PeekComparison" ( kind = "component" ) {',
    actor('Player', playerPlayback, -0.63, white),
    actor('NBAReference', referencePlayback, 0.63, yellow),
    ...(labels ? [
      'def Scope "NameMaterials" {', nameMaterial('White', white), nameMaterial('Yellow', yellow), '}',
      nameMesh('PlayerName', labels.player, -0.63, 'White', labels.atlas),
      nameMesh('NBAReferenceName', labels.reference, 0.63, 'Yellow', labels.atlas),
    ] : []),
    '}', '',
  ].join('\n');
  const files: { name: string; data: Uint8Array }[] = [{ name: 'PeekComparison.usda', data: new TextEncoder().encode(text) }];
  if (labels) files.push({ name: 'NameAtlas.png', data: labels.png });
  return buildUsdz(files);
}
