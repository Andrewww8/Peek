import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparisonPlayback, comparisonUsdz, coordinatesPerFrame, fingerCount, groundedShotPlayback, jointCount, legacyFingerCount,
  poseGround, posePoint, stabilizedShotPlayback, visiblePosePoint, type Pose, type PoseSample,
} from '../src/pose-3d.ts';
import type { JumpSample } from '../src/shot-grounding.ts';

const fps = 30;
const release = 24;

function player(frameCount: number): Pose {
  const joints = Array.from({ length: frameCount }, (_, frame) => {
    const dip = 0.13 * Math.exp(-((frame - 14) ** 2) / 30);
    const jitter = frame === 13 ? 0.085 : 0;
    const arms = 0.005 * frame;
    const row = Array<PoseSample>(coordinatesPerFrame).fill(null);
    row.splice(0, 6, 0, 0, 0, 0.1, 0, 0);
    row.splice(3 * 3, 3, 0.1, 0.57 - dip + jitter, 0);
    row.splice(6 * 3, 3, -0.1, 0.57 - dip + jitter, 0);
    row.splice(10 * 3, 3, jitter, -0.52, 0);
    row.splice(12 * 3, 3, -0.14 + arms + jitter, -0.22, 0);
    row.splice(13 * 3, 3, -0.1 + arms + jitter, -0.38, 0);
    row.splice(16 * 3, 3, 0.1 + arms + jitter, -0.38, 0);
    return row;
  }).flat();
  return { fps, releaseIndex: release, frameCount, shootingHand: 'right', joints, pelvisRise: null,
    metrics: { releaseElbowDeg: 92, kneeDipDeg: 47, releaseHeight: 0.26 } };
}

function height(pose: Pose, frame: number, joint: number) {
  return poseGround(pose) + pose.pelvisRise![frame]! - posePoint(pose, frame, joint)![1];
}

function acceleration(at: (frame: number) => number, frame: number) {
  return Math.abs(at(frame - 1) - 2 * at(frame) + at(frame + 1));
}

test('stabilizes whole-body motion while retaining planted feet, jump timing, and final body frame', () => {
  const source = player(40);
  const lift = [0, 0.015, 0.035, 0.06, 0.075, 0.085, 0.086, 0.078, 0.064, 0.05, 0.031, 0.015, 0.008, 0];
  source.jumpSamples = Array.from({ length: source.frameCount }, (_, frame): JumpSample => {
    const rise = lift[frame - 19] ?? 0;
    return [0.21 + rise, 0.22 + rise, 0.51 - (frame >= 10 && frame < 19 ? 0.10 : 0) + rise, 0.25];
  });
  const original = groundedShotPlayback(source, 0);
  const display = stabilizedShotPlayback(source, 0);
  assert.equal(display.releaseIndex, release);
  assert.deepEqual(display.metrics, source.metrics);
  for (const joint of [0, 10, 13, 16]) {
    assert.ok(acceleration((frame) => height(display, frame, joint), 13)
      < acceleration((frame) => height(original, frame, joint), 13) / 2);
  }
  for (let frame = 0; frame < display.frameCount; frame++) {
    assert.ok(Math.abs(height(display, frame, 3) - height(original, frame, 3)) < 1e-9);
  }
  assert.ok(height(display, 25, 3) > 0.05, 'confirmed jump is preserved');
  assert.ok(height(display, 14, 0) < height(display, 4, 0), 'actual dip still lowers the body');
  for (const joint of [0, 3, 6, 10, 13, 16]) {
    assert.deepEqual(posePoint(display, 39, joint), posePoint(source, 39, joint));
    assert.deepEqual(posePoint(display, 54, joint), posePoint(source, 39, joint));
  }
});

test('keeps on-device hands sparse and attached while the body fills gaps and holds its last frame', () => {
  const source = player(32);
  source.fingers = Array<PoseSample>(source.frameCount * fingerCount * 3).fill(null);
  function point(frame: number, joint: number, value: [number, number, number]) {
    source.fingers!.splice((frame * fingerCount + joint - jointCount) * 3, 3, ...value);
  }
  for (const frame of [12, 13, 15, 26, 27, 30, 31]) {
    const wrist = posePoint(source, frame, 13)!;
    point(frame, 21, [wrist[0], wrist[1] - 0.05, wrist[2]]);
    point(frame, 17, [wrist[0], wrist[1] - 0.10, wrist[2]]);
    point(frame, 19, [wrist[0] + 0.01, wrist[1] - 0.10, wrist[2]]);
  }
  source.joints.fill(null, 14 * coordinatesPerFrame, 15 * coordinatesPerFrame);
  for (let frame = 16; frame < 20; frame++) {
    const missingWrist = frame * coordinatesPerFrame + 13 * 3;
    source.joints.fill(null, missingWrist, missingWrist + 3);
  }
  const playback = comparisonPlayback(source, 3);
  const display = stabilizedShotPlayback(source, 3);
  assert.ok(posePoint(display, 14 - 3, 13), 'the body can bridge its measurement gap');
  assert.equal(visiblePosePoint(display, 14 - 3, 17), null);
  assert.equal(visiblePosePoint(display, 15 - 3, 19), null, 'an index tip needs its actual index knuckle');
  assert.ok(visiblePosePoint(display, 31 - 3, 17));
  assert.equal(visiblePosePoint(display, 32 - 3, 17), null);
  assert.ok(posePoint(display, 32 - 3, 13), 'the final body frame holds without inventing fingers');
  const original = posePoint(playback, 13 - 3, 13)!, stable = posePoint(display, 13 - 3, 13)!;
  assert.notDeepEqual(stable, original, 'the wrist is included in the body filter');
  const tip = visiblePosePoint(display, 13 - 3, 17)!;
  assert.equal(tip[0], stable[0]);
  assert.ok(Math.abs(tip[1] - stable[1] + 0.1) < 1e-9);

  const next = visiblePosePoint(comparisonPlayback(display), 32 - 3, 17);
  assert.equal(next, null, 'AR resampling must not resurrect a stale hand');
  const usd = new TextDecoder().decode(comparisonUsdz(display, display));
  assert.match(usd, /timeCodesPerSecond = 60/);
  const primTrack = (definition: string) => usd.split('def ' + definition)[1]?.split(/\ndef (?:Sphere|Cylinder|Xform) /)[0] ?? '';
  const samples = (definition: string, op: string) => {
    const values = primTrack(definition).split(`xformOp:${op}.timeSamples = {\n`)[1]?.split('}')[0];
    assert.ok(values, `${definition} has ${op} samples`);
    return new Map(Array.from(values.matchAll(/^([\d.]+): (\([^\n]+\))/gm), ([, time, value]) => [Number(time), value]));
  };
  for (const definition of ['Sphere "Finger_0"', 'Cylinder "Bone_21_17"']) {
    const track = primTrack(definition);
    // Quick Look versions that ignore the visibility track still see a near-zero scale.
    assert.match(track, /float3 xformOp:scale.timeSamples = \{[^}]*116: \(0\.00010, 0\.00010, 0\.00010\)/);
  }
  for (const [definition, before, after] of [
    ['Sphere "Finger_0"', (15 - 3) * 4, (26 - 3) * 4], ['Cylinder "Bone_21_17"', (15 - 3) * 4, (26 - 3) * 4],
    ['Sphere "Joint_13"', (15 - 3) * 4, (20 - 3) * 4], ['Cylinder "Bone_12_13"', (15 - 3) * 4, (20 - 3) * 4],
  ] as const) {
    const scale = samples(definition, 'scale');
    const hidden = '(0.00010, 0.00010, 0.00010)';
    assert.ok(scale.get(before) && scale.get(after));
    assert.notEqual(scale.get(before), hidden);
    assert.notEqual(scale.get(after), hidden);
    assert.equal(scale.get(before + 1), hidden);
    assert.equal(scale.get(after - 1), hidden);
    for (const op of definition.startsWith('Cylinder') ? ['translate', 'orient'] : ['translate']) {
      const pose = samples(definition, op);
      assert.equal(pose.get(before + 1), pose.get(before));
      assert.equal(pose.get(after - 1), pose.get(after));
    }
  }
  const coordinate = (definition: string, time: number) => samples(definition, 'translate').get(time)?.slice(1, -1).split(',').map(Number);
  const tick = (30 - 3) * 4 + 2;
  const arTip = coordinate('Sphere "Finger_0"', tick), knuckle = coordinate('Sphere "Finger_4"', tick);
  const center = coordinate('Cylinder "Bone_21_17"', tick);
  assert.ok(arTip && knuckle && center);
  assert.ok(center.every((value, axis) => Math.abs(value - (arTip[axis]! + knuckle[axis]!) / 2) < 2e-5));
});

test('retains measured legacy fingers and exports only valid hand connections in AR', () => {
  const source = player(32);
  const sample = Array<PoseSample>(legacyFingerCount * 3).fill(null);
  sample.splice(0, 3, -0.03, -0.48, 0);
  sample.splice(2 * 3, 3, -0.04, -0.46, 0);
  sample.splice(4 * 3, 3, -0.03, -0.43, 0);
  source.fingers = Array.from({ length: source.frameCount }, () => sample).flat();
  const pose = stabilizedShotPlayback(source, 0);
  assert.equal(pose.fingers?.length, pose.frameCount * legacyFingerCount * 3);
  assert.ok(visiblePosePoint(pose, release, 17));
  assert.equal(visiblePosePoint(pose, release, 19), null);
  const usd = new TextDecoder().decode(comparisonUsdz(pose, pose));
  assert.match(usd, /Bone_21_17/);
  assert.doesNotMatch(usd, /Bone_21_19|Finger_2/);
});
