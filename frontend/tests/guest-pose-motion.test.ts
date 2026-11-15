import assert from 'node:assert/strict';
import test from 'node:test';
import { guestPoseFromVision, type VisionFrame } from '../src/guest-pose-motion.ts';
import { comparisonPlayback, coordinatesPerFrame, fingerCount, jointCount, posePoint, shotMotionWindow } from '../src/pose-3d.ts';

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
  assert.deepEqual([high.fps, high.releaseIndex, high.frameCount], [30, 24, 55]);
  assert.deepEqual(posePoint(high, 24, 0), [0, 0, 0]);
  assert.notDeepEqual(posePoint(high, 24, 16), posePoint(low, 24, 16));
  assert.notDeepEqual(posePoint(high, 24, 16), posePoint(high, 28, 16));
  assert.deepEqual(posePoint(high, 24, 13), posePoint(low, 24, 13));
  assert.equal(high.shootingHand, 'right');
  const [first, last] = shotMotionWindow(high);
  assert.deepEqual([first, last], [18, 30]);
  const playback = comparisonPlayback(high, first);
  assert.equal(playback.releaseIndex, 6);
  assert.equal(playback.frameCount - 1 - playback.releaseIndex, playback.fps);
  assert.deepEqual(posePoint(playback, playback.frameCount - 1, 16), posePoint(high, last, 16));
  assert.notDeepEqual(posePoint(playback, 0, 16), posePoint(playback, 1, 16));
});

test('hand-only detections fill short gaps without covering observed misses or repeating a resting hand', () => {
  const hands = (index: number, height?: number): VisionFrame => {
    const fingerOffsets = Array<number | null>(fingerCount * 3).fill(null);
    if (height !== undefined) {
      fingerOffsets.splice(3, 3, 0, height, 0.02);
      fingerOffsets.splice(15, 3, 0, height / 2, 0.01);
    }
    return { index, joints: [], fingerOffsets };
  };
  const frames = shot(0.5);
  const bodyOnly = guestPoseFromVision(frames);
  const pose = guestPoseFromVision([...frames, hands(21, 0.09), hands(23, 0.13), hands(24),
    hands(25, 0.11), hands(30, 0.1), hands(33, 0.1)]);
  const tip = jointCount + 1;
  const wristRelativeY = (frame: number) => posePoint(pose, frame, tip)![1] - posePoint(pose, frame, 16)![1];

  assert.deepEqual(pose.joints, bodyOnly.joints);
  assert.equal(pose.releaseIndex, bodyOnly.releaseIndex);
  assert.ok(wristRelativeY(21) > wristRelativeY(22));
  assert.ok(wristRelativeY(22) > wristRelativeY(23));
  assert.ok(posePoint(pose, 30, tip));
  for (const frame of [20, 24, 26, 31, 33, 54]) {
    assert.equal(posePoint(pose, frame, tip), null);
  }
});

test('the player keeps moving across a release gap with later detections, then holds the last pose', () => {
  const pose = guestPoseFromVision(shot(0.5));
  const blank = (frame: number, end = frame + 1) =>
    pose.joints.fill(null, frame * coordinatesPerFrame, end * coordinatesPerFrame);
  blank(25, 29);
  blank(31, 37);
  const playback = comparisonPlayback({ ...pose, frameCount: 37 });
  assert.equal(playback.frameCount, 55);
  const wristHeight = (frame: number) => posePoint(playback, frame, 16)![1];
  for (let frame = 24; frame < 29; frame++) assert.ok(wristHeight(frame) > wristHeight(frame + 1));
  assert.deepEqual(posePoint(playback, 29, 16), posePoint(pose, 29, 16));
  assert.deepEqual(posePoint(playback, 31, 16), posePoint(pose, 30, 16));
  assert.deepEqual(posePoint(playback, 54, 16), posePoint(pose, 30, 16));
});

test('the final second uses measured motion and ignores motion beyond the comparison window', () => {
  const frames = shot(0.5);
  const last = frames.at(-1)!;
  const raisedWrist = (index: number, height: number): VisionFrame => ({
    index, joints: last.joints.map((value, coordinate) => coordinate === 16 * 3 + 1 ? value! + height : value),
  });
  const pose = guestPoseFromVision([...frames, raisedWrist(52, 0.4), raisedWrist(54, 0.5)]);
  const playback = comparisonPlayback(pose);
  assert.equal(playback.frameCount - 1 - playback.releaseIndex, 30);
  assert.notDeepEqual(posePoint(playback, 53, 16), posePoint(playback, 54, 16));
  assert.deepEqual(posePoint(playback, 54, 16), posePoint(pose, 54, 16));

  // An extra source frame beyond +1.0s cannot act as an interpolation endpoint.
  const overrun = structuredClone(pose);
  overrun.joints.fill(null, 54 * coordinatesPerFrame);
  overrun.joints.push(...pose.joints.slice(54 * coordinatesPerFrame));
  overrun.frameCount++;
  assert.deepEqual(posePoint(comparisonPlayback(overrun), 54, 16), posePoint(pose, 53, 16));
});

test('guest analysis rejects footage without a pose instead of providing sample motion', () => {
  assert.throws(() => guestPoseFromVision([]), /No clear body pose/);
});
