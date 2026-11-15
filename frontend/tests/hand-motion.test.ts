import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonPlayerPlayback, coordinatesPerFrame, fingerCount, handJoints, jointCount, posePoint, sampleComparisonPose, type Pose } from '../src/pose-3d.ts';
import { stabilizeHandMotion } from '../src/hand-motion.ts';

type Point = [number, number, number];

function record(): Pose {
  const frameCount = 24;
  return {
    fps: 30, releaseIndex: 9, frameCount, shootingHand: 'left',
    joints: Array(frameCount * coordinatesPerFrame).fill(null),
    fingers: Array(frameCount * fingerCount * 3).fill(null),
    pelvisRise: null,
    metrics: { releaseElbowDeg: 94, kneeDipDeg: 51, releaseHeight: 0.27 },
  };
}

function putSample(pose: Pose, frame: number, joint: number, value: Point) {
  if (joint < jointCount) {
    pose.joints.splice(frame * coordinatesPerFrame + joint * 3, 3, ...value);
  } else {
    pose.fingers!.splice((frame * fingerCount + joint - jointCount) * 3, 3, ...value);
  }
}

function offset(pose: Pose, frame: number, a: number, b: number): Point {
  const first = posePoint(pose, frame, a)!, second = posePoint(pose, frame, b)!;
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

test('samples in-between comparison frames without interpolating through missing hand measurements', () => {
  const pose = record();
  pose.pelvisRise = [0, 0.1, 0.2];
  for (let frame = 0; frame < 3; frame++) {
    const x = 0.06 * frame;
    putSample(pose, frame, 13, [x, 0, 0]);
    putSample(pose, frame, 21, [x, -0.05, 0]);
    if (frame > 0) putSample(pose, frame, 17, [x, -0.1, 0]);
  }
  assert.equal(sampleComparisonPose(pose, 0.5).points[17], null);
  assert.deepEqual(sampleComparisonPose(pose, 1).points[17], [0.06, -0.1, 0]);
  const sample = sampleComparisonPose(pose, 1.5);
  assert.ok(Math.abs(sample.pelvisRise - 0.15) < 1e-9);
  assert.deepEqual(sample.points[13], [0.09, 0, 0]);
  assert.deepEqual(sample.points[21], [0.09, -0.05, 0]);
  assert.deepEqual(sample.points[17], [0.09, -0.1, 0]);
});

test('rejects isolated finger reversals and bridges only supported gaps through release', () => {
  const pose = record();
  for (let frame = 0; frame < pose.frameCount; frame++) {
    const x = 0.004 * frame;
    putSample(pose, frame, 12, [x, 0.08, 0]);
    putSample(pose, frame, 13, [x, -0.06, 0]);
    putSample(pose, frame, 15, [x + 0.42, 0.08, 0]);
    putSample(pose, frame, 16, [x + 0.42, -0.06, 0]);
    if (frame >= 2 && frame <= 16 && ![7, 12, 13, 14].includes(frame)) {
      const angle = (frame - 3) * 0.06;
      const y = Math.cos(angle) * 0.05, z = Math.sin(angle) * 0.05;
      const reversal = frame === 2 ? 1 : -1;
      putSample(pose, frame, 21, [x, -0.06 + reversal * y, z * reversal]);
      putSample(pose, frame, 17, [x, -0.06 + reversal * (y + 0.042), 2 * z * reversal]);
      putSample(pose, frame, 23, [x + 0.018, -0.06 + reversal * y, z * reversal]);
      putSample(pose, frame, 19, [x + 0.027, -0.06 + reversal * (y + 0.048), 2 * z * reversal]);
    }
    if (frame >= 4 && frame <= 10) {
      putSample(pose, frame, 22, [x + 0.42, -0.102, 0]);
      const length = frame === 8 ? 0.001 : frame === 10 ? 0.013 : 0.038;
      putSample(pose, frame, 18, [x + 0.42, -0.102 - length, 0]);
    }
  }
  const filtered = comparisonPlayerPlayback(pose);
  for (const joint of [17, 19, 21, 23]) {
    assert.equal(posePoint(filtered, 2, joint), null, 'discard the isolated reversal at the first detection');
    assert.ok(posePoint(filtered, 7, joint), 'nearby agreeing observations can bridge a one-frame gap');
    assert.equal(posePoint(filtered, 13, joint), null, 'do not create fingers across a long tracking gap');
    assert.equal(posePoint(filtered, 17, joint), null, 'do not extend the last hand pose');
  }
  assert.ok(Math.hypot(...offset(filtered, 8, 18, 22)) > 0.03, 'bridge a collapsed measured finger');
  assert.ok(Math.hypot(...offset(filtered, 10, 18, 22)) < 0.03, 'keep a supported short finger flexion visible');
  assert.ok(offset(filtered, 9, 19, 23)[1] < -0.04, 'attach the index tip to its own index knuckle');
  assert.ok(offset(filtered, 11, 19, 13)[2] < offset(filtered, 9, 19, 13)[2] - 0.006, 'retain follow-through');
  assert.equal(filtered.releaseIndex, 9);
  assert.equal(filtered.frameCount, pose.releaseIndex + pose.fps + 1);
  assert.deepEqual(filtered.metrics, pose.metrics);
  assert.ok(posePoint(pose, 2, 17), 'do not mutate the saved source pose');
});

test('bounds wrist corrections and preserves the final hold', () => {
  const pose = record();
  for (let frame = 0; frame < pose.frameCount; frame++) {
    const x = 0.01 * Math.min(frame, 14);
    const wristY = frame === 9 ? -0.072 : -0.14;
    putSample(pose, frame, 3, [0, 0.54, 0]);
    putSample(pose, frame, 12, [x, 0, 0]);
    putSample(pose, frame, 13, [x, wristY, 0]);
    putSample(pose, frame, 21, [x, wristY - 0.04, 0]);
    putSample(pose, frame, 17, [x, wristY - 0.08, 0]);
  }
  const filtered = stabilizeHandMotion(pose, handJoints);
  assert.ok(Math.hypot(...offset(filtered, 9, 13, 12)) > 0.12, 'steady the wrist near the measured forearm length');
  for (let frame = 0; frame < pose.frameCount; frame++) {
    const before = posePoint(pose, frame, 13)!, after = posePoint(filtered, frame, 13)!;
    assert.ok(Math.hypot(...after.map((value, index) => value - before[index]!)) <= 0.0520001);
    assert.deepEqual(posePoint(filtered, frame, 3), posePoint(pose, frame, 3));
    assert.deepEqual(posePoint(filtered, frame, 12), posePoint(pose, frame, 12));
    assert.ok(Math.abs(offset(filtered, frame, 17, 13)[1] + 0.08) < 1e-9, 'move the fingers with the corrected wrist');
  }
  for (let frame = 14; frame < pose.frameCount; frame++) {
    assert.deepEqual(posePoint(filtered, frame, 13), posePoint(pose, 14, 13));
  }
});
