import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinatesPerFrame, groundedShotPlayback, poseGround, posePoint, type Pose } from '../src/pose-3d.ts';
import { jumpClearance, type JumpSample } from '../src/shot-grounding.ts';

const fps = 30;
const release = 24;
const frameCount = release + fps + 1;

function player(jumpSamples?: (JumpSample | null)[]): Pose {
  const joints = Array.from({ length: frameCount }, (_, frame) => {
    const bend = frame >= 10 && frame < 19 ? 0.26 : 0.57;
    const row = Array<number | null>(coordinatesPerFrame).fill(null);
    row.splice(0, 6, 0, 0, 0, 0.1, 0, 0);
    row.splice(9, 3, 0.1, bend, 0);
    row.splice(18, 3, -0.1, bend, 0);
    return row;
  }).flat();
  return {
    fps, releaseIndex: release, frameCount, shootingHand: 'right', joints, jumpSamples,
    pelvisRise: Array.from({ length: frameCount }, (_, i) => i === 12 ? -0.85 : 0.3),
    metrics: { releaseElbowDeg: null, kneeDipDeg: null, releaseHeight: null },
  };
}

function height(pose: Pose, frame: number, joint: number) {
  return poseGround(pose) + pose.pelvisRise![frame]! - posePoint(pose, frame, joint)![1];
}

test('a deep dip keeps both measured feet on the floor even when the old root translation is wrong', () => {
  const original = player();
  const pose = groundedShotPlayback(original, 0);
  for (let frame = 0; frame < frameCount; frame++) {
    for (const ankle of [3, 6]) assert.ok(Math.abs(height(pose, frame, ankle)) < 1e-9);
  }
  assert.ok(height(pose, 12, 0) < height(pose, 4, 0), 'hips still lower into the dip');
  assert.deepEqual(pose.joints, original.joints, 'ankle anchoring preserves body geometry');
});

test('both feet leave the floor only through the measured jump and return together on landing', () => {
  const arc = [0, 0.015, 0.035, 0.06, 0.075, 0.085, 0.086, 0.078, 0.064, 0.050, 0.031, 0.015, 0.008, 0];
  const evidence = Array.from({ length: frameCount }, (_, frame): JumpSample => {
    const rise = arc[frame - 19] ?? 0;
    const pelvis = 0.51 - (frame >= 10 && frame < 19 ? 0.10 : 0) + rise;
    return [0.21 + rise, 0.22 + rise, pelvis, 0.25];
  });
  // A low crouch can hide the ankles until a few frames before takeoff.
  const lateEvidence = evidence.map((sample, frame) => frame < 17 ? null : sample);
  const pose = groundedShotPlayback(player(lateEvidence), 0);
  assert.ok(Math.abs(height(pose, 15, 3)) < 1e-9);
  assert.ok(height(pose, release + 2, 3) > 0.06);
  assert.equal(height(pose, release + 2, 3), height(pose, release + 2, 6));
  assert.ok(Math.abs(height(pose, 35, 3)) < 1e-9);
});

test('a step and a camera drift through a dip do not satisfy the takeoff and landing checks', () => {
  for (const leftFootOff of [false, true]) {
    const evidence = Array.from({ length: frameCount }, (_, frame): JumpSample => {
      const drift = Math.max(0, frame - 10) * 0.008;
      return [0.2 + drift, 0.2 + (leftFootOff ? 0 : drift), 0.50 + drift, 0.24];
    });
    assert.ok(jumpClearance(evidence, frameCount, release, fps).every((value) => value === 0));
  }
});
