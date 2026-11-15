import assert from 'node:assert/strict';
import test from 'node:test';
import { guestPoseFromVision, type VisionFrame } from '../src/guest-pose-motion.ts';
import { posePoint } from '../src/pose-3d.ts';

const body = [
  [0, 1, -3],
  [-0.15, 0.95, -3], [-0.17, 0.55, -3], [-0.2, 0.08, -3.05],
  [0.15, 0.95, -3], [0.17, 0.55, -3], [0.2, 0.08, -3.05],
  [0, 1.2, -3], [0, 1.44, -3], [0, 1.63, -2.95], [0, 1.76, -3],
  [0.23, 1.43, -3], [0.32, 1.52, -2.89], [0.39, 1.58, -2.8],
  [-0.23, 1.43, -3], [-0.32, 1.59, -2.89], [-0.39, 1.67, -2.8],
];

function shot(wristRise: number): VisionFrame[] {
  return [18, 20, 22, 24, 26, 28, 30].map((index) => ({
    index,
    joints: body.flatMap(([x, y, z], joint) => [x, y + (joint === 16 ? wristRise * (index - 18) / 12 : 0), z]),
  }));
}

test('guest motion follows the selected recording and stays aligned to the release', () => {
  const low = guestPoseFromVision(shot(0.2));
  const high = guestPoseFromVision(shot(0.5));
  assert.deepEqual([high.fps, high.releaseIndex, high.frameCount], [30, 24, 37]);
  assert.deepEqual(posePoint(high, 24, 0), [0, 0, 0]);
  assert.notDeepEqual(posePoint(high, 24, 16), posePoint(low, 24, 16));
  assert.notDeepEqual(posePoint(high, 24, 16), posePoint(high, 28, 16));
  assert.deepEqual(posePoint(high, 24, 13), posePoint(low, 24, 13));
  assert.equal(high.shootingHand, 'right');
});

test('guest analysis rejects footage without a pose instead of providing sample motion', () => {
  assert.throws(() => guestPoseFromVision([]), /No clear body pose/);
});
