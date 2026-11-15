import { buildUsdz } from '../../mobile/src/core/usdz.ts';

export type PoseSample = number | null;
export type Pose = {
  fps: number;
  releaseIndex: number;
  frameCount: number;
  shootingHand: 'right' | 'left';
  joints: PoseSample[];
  fingers?: PoseSample[] | null;
  pelvisRise: PoseSample[] | null;
  metrics: { releaseElbowDeg: PoseSample; kneeDipDeg: PoseSample; releaseHeight: PoseSample };
};

export const jointCount = 17;
export const coordinatesPerFrame = jointCount * 3;
export const fingerCount = 6;
export const posePointCount = jointCount + fingerCount;
export const bones = [
  [0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6],
  [0, 7], [7, 8], [8, 9], [9, 10], [8, 11], [11, 12], [12, 13], [8, 14], [14, 15], [15, 16],
  [13, 21], [16, 22], [21, 17], [22, 18], [21, 19], [22, 20],
] as const;

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
  const index = finger ? (frame * fingerCount + joint - jointCount) * 3 : frame * coordinatesPerFrame + joint * 3;
  const x = values?.[index], y = values?.[index + 1], z = values?.[index + 2];
  return x == null || y == null || z == null ? null : [x, y, z];
}

function anchor(pose: Pose, frame: number, joint: number, ground: number, offset: number): Vector | null {
  const point = posePoint(pose, frame, joint);
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
  for (let joint = 0; joint < posePointCount; joint++) {
    const positions = frames.map((sample) => sample[joint] ?? null);
    if (!positions.some(Boolean)) continue;
    const finger = joint >= jointCount;
    parts.push('def Sphere "' + (finger ? 'Finger_' + String(joint - jointCount) : 'Joint_' + String(joint)) + '" {',
      'double radius = ' + (finger ? '0.013' : joint === 10 ? '0.056' : '0.027'), color,
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
      'uniform token axis = "Y"', 'double radius = ' + (to >= jointCount ? '0.007' : '0.016'), 'double height = 2', color,
      track('double3', 'translate', data.map((item) => item?.center ?? null), [offset, 0, 0]),
      track('quatf', 'orient', data.map((item) => item?.rotation ?? null), [1, 0, 0, 0]),
      track('float3', 'scale', data.map((item) => item?.scale ?? null), [1, 0, 1]), visibility(data),
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
  if (player.fps !== reference.fps || player.frameCount !== reference.frameCount || player.releaseIndex !== reference.releaseIndex) {
    throw new Error('The two shots must use the same release timeline.');
  }
  const fps = String(player.fps / 2);
  const white: Vector = [1, 1, 1];
  const yellow: Vector = [1, 0.79, 0.04];
  const text = [
    '#usda 1.0', '(',
    'defaultPrim = "PeekComparison"', 'metersPerUnit = 1', 'upAxis = "Y"',
    'startTimeCode = 0', 'endTimeCode = ' + String(player.frameCount - 1),
    'timeCodesPerSecond = ' + fps, 'framesPerSecond = ' + fps, ')',
    'def Xform "PeekComparison" ( kind = "component" ) {',
    actor('Player', player, -0.63, white),
    actor('NBAReference', reference, 0.63, yellow),
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
