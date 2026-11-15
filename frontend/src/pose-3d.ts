import { buildUsdz } from '../../mobile/src/core/usdz.ts';

export type PoseSample = number | null;
export type Pose = {
  fps: number;
  releaseIndex: number;
  frameCount: number;
  shootingHand: 'right' | 'left';
  joints: PoseSample[];
  pelvisRise: PoseSample[] | null;
  metrics: { releaseElbowDeg: PoseSample; kneeDipDeg: PoseSample; releaseHeight: PoseSample };
};

export const jointCount = 17;
export const coordinatesPerFrame = jointCount * 3;
export const bones = [
  [0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6],
  [0, 7], [7, 8], [8, 9], [9, 10], [8, 11], [11, 12], [12, 13], [8, 14], [14, 15], [15, 16],
] as const;

type Vector = [number, number, number];
type Rotation = [number, number, number, number];

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

function anchor(pose: Pose, frame: number, joint: number, ground: number, offset: number): Vector | null {
  const index = frame * coordinatesPerFrame + joint * 3;
  const [x, y, z] = pose.joints.slice(index, index + 3);
  if (x == null || y == null || z == null) return null;
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
    Array.from({ length: jointCount }, (_, joint) => anchor(pose, frame, joint, ground, offset)),
  );
  const color = 'color3f[] primvars:displayColor = [' + tuple(tint) + ']';
  const parts = ['def Xform "' + id + '" {'];
  for (let joint = 0; joint < jointCount; joint++) {
    const positions = frames.map((sample) => sample[joint] ?? null);
    if (!positions.some(Boolean)) continue;
    parts.push('def Sphere "Joint_' + String(joint) + '" {',
      'double radius = ' + (joint === 10 ? '0.056' : '0.027'), color,
      track('double3', 'translate', positions, [offset, 0, 0]), visibility(positions),
      'uniform token[] xformOpOrder = ["xformOp:translate"]', '}');
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
    parts.push('def Cylinder "Bone_' + String(from) + '_' + String(to) + '" {',
      'uniform token axis = "Y"', 'double radius = 0.016', 'double height = 2', color,
      track('double3', 'translate', data.map((item) => item?.center ?? null), [offset, 0, 0]),
      track('quatf', 'orient', data.map((item) => item?.rotation ?? null), [1, 0, 0, 0]),
      track('float3', 'scale', data.map((item) => item?.scale ?? null), [1, 0, 1]), visibility(data),
      'uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]', '}');
  }
  parts.push('}');
  return parts.join('\n');
}

export function comparisonUsdz(player: Pose, reference: Pose) {
  if (player.fps !== reference.fps || player.frameCount !== reference.frameCount || player.releaseIndex !== reference.releaseIndex) {
    throw new Error('The two shots must use the same release timeline.');
  }
  const fps = String(player.fps / 2);
  const text = [
    '#usda 1.0', '(',
    'defaultPrim = "PeekComparison"', 'metersPerUnit = 1', 'upAxis = "Y"',
    'startTimeCode = 0', 'endTimeCode = ' + String(player.frameCount - 1),
    'timeCodesPerSecond = ' + fps, 'framesPerSecond = ' + fps, ')',
    'def Xform "PeekComparison" ( kind = "component" ) {',
    actor('Player', player, -0.63, [1, 1, 1]),
    actor('NBAReference', reference, 0.63, [1, 0.79, 0.04]),
    '}', '',
  ].join('\n');
  return buildUsdz([{ name: 'PeekComparison.usda', data: new TextEncoder().encode(text) }]);
}
