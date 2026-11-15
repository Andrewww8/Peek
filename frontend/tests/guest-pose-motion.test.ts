import assert from 'node:assert/strict';
import test from 'node:test';
import { guestPoseFromVision, type VisionFrame } from '../src/guest-pose-motion.ts';
import { comparisonPlayback, comparisonUsdz, coordinatesPerFrame, fingerCount, jointCount, posePoint, shotMotionWindow } from '../src/pose-3d.ts';

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

function finger(frame: VisionFrame, point: number, offset: [number, number, number]) {
  const joint = point % 2 === 0 ? 13 : 16;
  const xyz = offset.map((value, axis) => frame.joints[joint * 3 + axis]! + value);
  frame.fingers ??= Array(fingerCount * 3).fill(null);
  frame.fingers.splice(point * 3, 3, ...xyz);
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

test('the player’s measured finger points stay attached to their own wrists at release', () => {
  const frames = shot(0.5);
  for (const frame of frames) {
    if (frame.index !== 22 && frame.index !== 26) continue;
    finger(frame, 0, [0.02, 0.11, 0.03]);
    finger(frame, 1, [-0.02, frame.index === 22 ? 0.10 : 0.14, 0.04]);
    finger(frame, 3, [-0.04, 0.10, 0.04]);
    finger(frame, 5, [-0.02, 0.06, 0.02]);
  }
  // Wrist motion is nonlinear between the detected hand frames.
  frames[3]!.joints[16 * 3 + 1]! += 0.2;
  const pose = guestPoseFromVision(frames);
  assert.equal(pose.fingers?.length, pose.frameCount * fingerCount * 3);
  const rightTip = (frame: number) => posePoint(pose, frame, jointCount + 1)!;
  const rightWrist = (frame: number) => posePoint(pose, frame, 16)!;
  const rightTipOffset = (frame: number) => rightTip(frame)[1] - rightWrist(frame)[1];
  assert.ok(Math.abs(rightTipOffset(24) - (rightTipOffset(22) + rightTipOffset(26)) / 2) < 0.0002);
  assert.ok(rightTip(24)[1] < rightTip(22)[1]);
  assert.ok(posePoint(pose, 24, jointCount)![0] > posePoint(pose, 24, 13)![0]);
  assert.ok(posePoint(pose, 24, jointCount + 3));
  assert.ok(posePoint(pose, 24, jointCount + 5));
  assert.equal(posePoint(pose, 24, jointCount + 2), null);
});

test('finger landmarks stay hidden through long occlusions and keep their final detected pose on a short clip', () => {
  const frames = shot(0.5);
  finger(frames[0]!, 1, [-0.02, 0.11, 0.04]);
  finger(frames.at(-1)!, 1, [-0.03, 0.12, 0.06]);
  finger(frames.at(-1)!, 0, [0.03, 0.12, 0.06]);
  frames.at(-1)!.joints.fill(null, 13 * 3, 14 * 3);
  const pose = guestPoseFromVision(frames);
  assert.ok(posePoint(pose, 24, 16));
  assert.equal(posePoint(pose, 24, jointCount + 1), null);
  assert.equal(posePoint(pose, 30, jointCount), null);
  assert.ok(posePoint(pose, 30, jointCount + 1));
  assert.deepEqual(posePoint(pose, 54, jointCount + 1), posePoint(pose, 30, jointCount + 1));
  assert.equal(guestPoseFromVision(shot(0.5)).fingers, undefined);
});

test('playback bridges longer gaps in body motion while keeping occluded fingers hidden', () => {
  const frames = shot(0.5).filter(({ index }) => index <= 24);
  const late = { ...shot(0.5).at(-1)!, index: 38 };
  finger(frames.at(-1)!, 1, [-0.02, 0.11, 0.04]);
  finger(late, 1, [-0.03, 0.12, 0.06]);
  const pose = comparisonPlayback(guestPoseFromVision([...frames, late]));
  assert.ok(posePoint(pose, 24, jointCount + 1));
  assert.ok(posePoint(pose, 29, 16));
  assert.equal(posePoint(pose, 29, jointCount + 1), null);
  assert.ok(posePoint(pose, 38, jointCount + 1));
});

test('AR exports animated finger and wrist tracks on the white player', () => {
  const frames = shot(0.5);
  for (const frame of frames) {
    finger(frame, 1, [-0.02, 0.10 + (frame.index - 18) / 250, 0.04]);
    finger(frame, 3, [-0.04, 0.10, 0.04]);
    finger(frame, 5, [-0.02, 0.06, 0.02]);
  }
  const player = comparisonPlayback(guestPoseFromVision(frames));
  const reference = comparisonPlayback(guestPoseFromVision(shot(0.2)));
  const usdz = comparisonUsdz(player, reference);
  // USDZ stores the scene as the first uncompressed ZIP entry.
  const header = new DataView(usdz.buffer, usdz.byteOffset, usdz.byteLength);
  assert.equal(header.getUint32(0, true), 0x04034b50);
  assert.equal(header.getUint16(8, true), 0);
  const offset = 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const scene = new TextDecoder().decode(usdz.subarray(offset, offset + header.getUint32(18, true)));
  const [white, yellow] = scene.split('def Xform "NBAReference"');
  assert.match(white!, /def Xform "Player"[\s\S]+primvars:displayColor = \[\(1\.00000, 1\.00000, 1\.00000\)\]/);
  assert.match(white!, /def Cylinder "Bone_15_16"/);
  assert.match(white!, /def Cylinder "Bone_16_22"/);
  assert.match(white!, /def Cylinder "Bone_22_18"/);
  const samples = (name: string) => {
    const track = white!.split(`def Sphere "${name}" {`)[1]?.split('timeSamples = {\n')[1]?.split('\n}')[0];
    assert.ok(track);
    return track.split(',\n');
  };
  const tip = samples('Finger_1');
  const wrist = samples('Joint_16');
  const point = (track: string[], frame: number) => track[frame]?.split(': ')[1];
  assert.ok(point(tip, 24));
  assert.notEqual(point(tip, 24), point(tip, 26));
  assert.notEqual(point(tip, 24), point(wrist, 24));
  assert.notEqual(point(wrist, 24), point(wrist, 26));
  assert.doesNotMatch(yellow!, /def Sphere "Finger_1"/);
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
