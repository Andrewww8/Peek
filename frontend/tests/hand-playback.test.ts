import assert from 'node:assert/strict';
import test from 'node:test';

import { smoothPlayerHands } from '../src/hand-playback.ts';
import { comparisonUsdz, coordinatesPerFrame, fingerCount, jointCount, poseGround, posePoint,
  type Pose, type PoseSample } from '../src/pose-3d.ts';

const fps = 30;
const releaseIndex = 24;
const frameCount = 55;
const upperLength = 0.21;
const forearmLength = 0.19;

function shot(): Pose {
  const joints: PoseSample[] = [];
  const fingers: PoseSample[] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const row = Array<PoseSample>(coordinatesPerFrame).fill(null);
    row.splice(0, 6, 0, 0, 0, 0.1, 0, 0);
    row.splice(9, 3, 0.1, 0.54, 0);
    row.splice(18, 3, -0.1, 0.55, 0);
    const angle = (frame - releaseIndex) * 0.035 + (frame === releaseIndex ? 1.5 : 0);
    const sx = 0.23, sy = -0.40;
    const ex = sx + upperLength * Math.sin(angle), ey = sy - upperLength * Math.cos(angle);
    const wy = ey - forearmLength * Math.cos(angle), wz = forearmLength * Math.sin(angle);
    row.splice(11 * 3, 9, sx, sy, 0, ex, ey, 0, ex, wy, wz);
    joints.push(...row);

    const hand = Array<PoseSample>(fingerCount * 3).fill(null);
    if ([6, 21, 22, 23, 24, 25, 26, 27, 30].includes(frame)) {
      const tipZ = frame === releaseIndex ? -0.08 : 0.04;
      hand.splice(0, 3, ex + 0.02, wy - 0.08, wz + tipZ);
    }
    fingers.push(...hand);
  }
  return { fps, releaseIndex, frameCount, shootingHand: 'left', joints, fingers,
    pelvisRise: Array.from({ length: frameCount }, (_, i) => i < 20 ? -0.12 : 0),
    metrics: { releaseElbowDeg: 90, kneeDipDeg: 60, releaseHeight: 0.3 } };
}

const distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, axis) => value - b[axis]!));

function reversal(pose: Pose, joint: number, relative?: number) {
  const points = [-1, 0, 1].map((step) => {
    const frame = releaseIndex + step;
    const point = posePoint(pose, frame, joint)!;
    const anchor = relative === undefined ? [0, 0, 0] : posePoint(pose, frame, relative)!;
    return point.map((coordinate, axis) => coordinate - anchor[axis]!);
  });
  const [before, center, after] = points.map((point) => point[2]!);
  return Math.abs(after! - 2 * center! + before!);
}

test('smooths arm and finger reversals without changing release, foot placement, or bone lengths', () => {
  const original = shot();
  const smooth = smoothPlayerHands(original, 30);

  assert.equal(smooth.releaseIndex, releaseIndex);
  assert.deepEqual(smooth.pelvisRise, original.pelvisRise);
  assert.equal(poseGround(smooth), poseGround(original));
  assert.deepEqual(smooth.metrics, original.metrics);
  assert.ok(reversal(smooth, 13) < reversal(original, 13) * 0.35);
  assert.ok(reversal(smooth, jointCount, 13) < reversal(original, jointCount, 13) * 0.35);
  for (let frame = 0; frame < frameCount; frame++) {
    for (const joint of [0, 3, 6, 11]) {
      assert.deepEqual(posePoint(smooth, frame, joint), posePoint(original, frame, joint));
    }
    const shoulder = posePoint(smooth, frame, 11)!;
    const elbow = posePoint(smooth, frame, 12)!;
    const wrist = posePoint(smooth, frame, 13)!;
    assert.ok(Math.abs(distance(shoulder, elbow) - upperLength) < 1e-6);
    assert.ok(Math.abs(distance(elbow, wrist) - forearmLength) < 1e-6);
  }
});

test('holds the smoothed final hand pose and keeps occluded fingers hidden', () => {
  const original = shot();
  const lastFrame = 30;
  const smooth = smoothPlayerHands(original, lastFrame);
  assert.ok(posePoint(smooth, 7, jointCount), 'one adjacent dropout can use a nearby observation');
  assert.equal(posePoint(smooth, 14, jointCount), null, 'the middle of a long gap stays hidden');
  assert.ok(posePoint(smooth, 29, jointCount), 'short gaps between detections remain connected');
  assert.equal(posePoint(smooth, releaseIndex, jointCount + 1), null, 'untracked opposite hand stays absent');
  for (const joint of [12, 13, jointCount]) {
    assert.deepEqual(posePoint(smooth, frameCount - 1, joint), posePoint(smooth, lastFrame, joint));
  }
});

test('AR exports the same smoothed wrist and fingertip positions as playback', () => {
  const original = shot();
  const smooth = smoothPlayerHands(original, 30);
  const usdz = comparisonUsdz(smooth, { ...original, fingers: undefined });
  const header = new DataView(usdz.buffer, usdz.byteOffset, usdz.byteLength);
  const start = 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const scene = new TextDecoder().decode(usdz.subarray(start, start + header.getUint32(18, true)));
  const white = scene.split('def Xform "NBAReference"')[0]!;
  for (const [joint, name] of [[13, 'Joint_13'], [jointCount, 'Finger_0']] as const) {
    const [x, y, z] = posePoint(smooth, releaseIndex, joint)!;
    const track = white.split(`def Sphere "${name}" {`)[1]!.split('timeSamples = {\n')[1]!.split('\n}')[0]!;
    const expected = [x * 1.75 - 0.63, (poseGround(smooth) + smooth.pelvisRise![releaseIndex]! - y) * 1.75, -z * 1.75]
      .map((value) => value.toFixed(5)).join(', ');
    assert.ok(track.includes(`${releaseIndex}: (${expected})`));
  }
});
