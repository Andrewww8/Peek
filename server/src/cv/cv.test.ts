import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { detectCandidates } from './detector.js';
import { AnalysisError, analyzeClipNpz, analyzeSeries, computeMetrics, pickShooter, poseArraysFromNpz, recompute } from './metrics.js';
import { NpzError, parseNpy, readNpz } from './npz.js';
import { decodePose, encodePose, quantize, J } from './pose.js';
import { SHOT, encodeNpy, joints3d, syntheticShot, to2d, writeNpz } from './test-pose.js';

const SAMPLE = '/Users/danielvargas/Documents/Perspective Project/_EuBHf42Zs8.npz';
const haveSample = existsSync(SAMPLE);
const W = { taggedReleaseFrame: SHOT.release, windowStart: 0, windowEnd: SHOT.frames - 1, cuts: [] as number[] };
const near = (actual: number | null, expected: number, tol: number, what: string) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `${what}: ${actual}, expected ${expected} ± ${tol}`);

describe('npz reader', () => {
  test('reads the sample CV output: all 14 arrays with their shapes and dtypes', { skip: !haveSample && 'sample npz not present' }, () => {
    const a = readNpz(readFileSync(SAMPLE));
    const want: Record<string, [string, number[]]> = {
      track: ['<i4', [20458]], frame: ['<i4', [20458]], kpts2d: ['<f4', [20458, 17, 2]], conf: ['<f4', [20458, 17]], bbox: ['<f4', [20458, 4]],
      pose3d: ['<f4', [20458, 17, 3]], pose3d_unit: ['<f4', [20458, 17, 3]], joint_names: ['<U10', [17]], bones: ['<i8', [16, 2]],
      fps: ['<f8', []], eff_fps: ['<f8', []], width: ['<i8', []], height: ['<i8', []], cuts: ['<i4', [14]],
    };
    assert.deepEqual(Object.keys(a).sort(), Object.keys(want).sort());
    for (const [k, [dtype, shape]] of Object.entries(want)) assert.deepEqual([a[k]!.dtype, a[k]!.shape], [dtype, shape], k);
    assert.equal((a.joint_names!.data as string[]).join(','), 'pelvis,r_hip,r_knee,r_ankle,l_hip,l_knee,l_ankle,spine,thorax,nose,head,l_shoulder,l_elbow,l_wrist,r_shoulder,r_elbow,r_wrist');
    assert.deepEqual([a.width!.data[0], a.height!.data[0]], [1280, 720]);
    assert.ok(Math.abs((a.fps!.data[0] as number) - 29.97) < 0.01);
    assert.equal(new Set(a.track!.data as Int32Array).size, 422);
  });

  test('the 3D up axis is −y: the head sits above the pelvis and the ankles below it', { skip: !haveSample && 'sample npz not present' }, () => {
    const p = poseArraysFromNpz(readFileSync(SAMPLE));
    let head = 0, ankle = 0, n = 0;
    for (let i = 0; i < p.track.length; i++) {
      const o = i * 51;
      const h = p.pose3d[o + J.head * 3 + 1]! - p.pose3d[o + 1]!, a = p.pose3d[o + J.r_ankle * 3 + 1]! - p.pose3d[o + 1]!;
      if (Number.isNaN(h) || Number.isNaN(a)) continue;
      head += h; ankle += a; n++;
    }
    assert.ok(head / n < -0.3, `mean head − pelvis y = ${head / n}`);
    assert.ok(ankle / n > 0.3, `mean ankle − pelvis y = ${ankle / n}`);
  });

  test('rejects pickled object arrays, Fortran order, bad magic, truncation and non-zips', () => {
    const pickled = encodeNpy('|O', [1], new Uint8Array([0x80, 0x04, 0x95]));
    assert.throws(() => parseNpy(pickled), /object arrays/);
    assert.throws(() => readNpz(zipSync({ 'a.npy': pickled })), NpzError);
    const fortran = encodeNpy('<f4', [2], new Uint8Array(8));
    const f2 = Buffer.from(fortran);
    f2.write("'fortran_order': True ", Buffer.from(fortran).indexOf("'fortran_order'"), 'latin1');
    assert.throws(() => parseNpy(new Uint8Array(f2)), /Fortran/);
    assert.throws(() => parseNpy(new Uint8Array(20)), /not an \.npy/);
    assert.throws(() => parseNpy(encodeNpy('<f4', [10], new Uint8Array(8))), /truncated/);
    assert.throws(() => parseNpy(encodeNpy('>f4', [1], new Uint8Array(4))), /unsupported dtype/);
    assert.throws(() => readNpz(new Uint8Array([1, 2, 3, 4])), NpzError);
    assert.throws(() => readNpz(zipSync({ 'readme.txt': new Uint8Array(3) })), /no arrays/);
  });

  test('reads v2 headers, scalars, unicode and int64', () => {
    const v1 = encodeNpy('<i8', [2], new Uint8Array(new BigInt64Array([5n, -7n]).buffer));
    const v2 = new Uint8Array(v1.length + 2);
    v2.set(v1.subarray(0, 6));
    v2[6] = 2;
    new DataView(v2.buffer).setUint32(8, new DataView(v1.buffer).getUint16(8, true), true);
    v2.set(v1.subarray(10), 12);
    assert.deepEqual(Array.from(parseNpy(v2).data as Float64Array), [5, -7]);
    const tooBig = encodeNpy('<i8', [1], new Uint8Array(new BigInt64Array([2n ** 60n]).buffer));
    assert.throws(() => parseNpy(tooBig), /safe integer/);
  });

  test('validates the CV contract: missing arrays, wrong shapes, joint order', () => {
    const good = writeNpz([{ track: 1, series: syntheticShot() }]);
    assert.doesNotThrow(() => poseArraysFromNpz(good));
    const noConf = writeNpz([{ track: 1, series: syntheticShot() }], { extra: { 'conf.npy': encodeNpy('<f4', [3, 2], new Uint8Array(24)) } });
    assert.throws(() => poseArraysFromNpz(noConf), /conf has shape/);
  });
});

describe('compact pose', () => {
  test('round-trips within the quantization step and keeps NaN', () => {
    const s = syntheticShot({ no3d: true });
    const d = decodePose(encodePose(s));
    assert.deepEqual(d.frames, s.frames);
    for (let i = 0; i < s.kpts2d.length; i++) assert.ok(Math.abs(d.kpts2d[i]! - s.kpts2d[i]!) <= 0.125 + 1e-6);
    assert.ok(d.pose3d.every(Number.isNaN));
    const q = quantize(syntheticShot());
    assert.deepEqual(decodePose(q.compact), q.series);
  });
});

describe('shot metrics on a synthetic shooter with known angles', () => {
  test('golden values', () => {
    const a = analyzeSeries(syntheticShot(), 7, W);
    const m = a.metrics;
    assert.equal(m.shootingHand, 'right');
    assert.equal(m.releaseFrame, SHOT.release);
    assert.equal(m.releaseOffsetFrames, 0);
    near(m.elbowAngleSetPointDeg, SHOT.elbowSet, 0.5, 'set-point elbow');
    near(m.elbowAngleReleaseDeg, SHOT.elbowRelease, 0.5, 'release elbow');
    near(m.kneeFlexionMinDeg, SHOT.kneeMin, 0.5, 'knee dip');
    assert.equal(m.dipToReleaseMs, Math.round(((SHOT.release - SHOT.dip) * 1000) / SHOT.fps));
    near(m.trunkLeanDeg, 0, 0.5, 'trunk lean');
    near(m.elbowFlareRatio, 0, 0.01, 'elbow flare');
    assert.equal(m.followThroughHoldMs, Math.round((SHOT.holdFrames * 1000) / SHOT.fps));
    near(m.ankleSpreadRatio, 0.5, 0.01, 'ankle spread');
    near(m.pelvisDriftRatio, 0, 0.001, 'pelvis drift');
    // Height and jump, from the generator's own 2D geometry.
    const rel = joints3d(SHOT.release), dip = joints3d(SHOT.dip);
    const s = syntheticShot();
    const boxH = (f: number) => s.bbox[f * 4 + 3]! - s.bbox[f * 4 + 1]!;
    near(m.releaseHeightRatio, (to2d(rel[J.head]!)[1]! - to2d(rel[J.r_wrist]!)[1]!) / boxH(SHOT.release), 0.002, 'release height');
    near(m.jumpRiseRatio, (to2d(dip[J.pelvis]!)[1]! - to2d(rel[J.pelvis]!)[1]!) / boxH(SHOT.dip), 0.002, 'jump rise');
    assert.deepEqual(a.quality.warnings, []);
    assert.equal(a.quality.usable, true);
    assert.equal(a.quality.coverage, 1);
    // 10 Hz series around release
    assert.equal(a.series.tMs.length, 31);
    assert.equal(a.series.tMs[20], 0);
    near(a.series.elbow[20]!, SHOT.elbowRelease, 0.5, 'series elbow at release');
  });

  test('the release is refined from the tag to the wrist peak', () => {
    const m = analyzeSeries(syntheticShot(), 1, { ...W, taggedReleaseFrame: SHOT.release - 4 }).metrics;
    assert.deepEqual([m.releaseFrame, m.releaseOffsetFrames], [SHOT.release, 4]);
  });

  test('without 3D the angles fall back to 2D, and flare is unavailable', () => {
    const a = analyzeSeries(syntheticShot({ no3d: true }), 1, W);
    assert.equal(a.metrics.elbowFlareRatio, null);
    assert.ok(a.quality.warnings.includes('little_3d_pose'));
    near(a.metrics.kneeFlexionMinDeg, 180, 0.5, 'a knee bending towards the camera looks straight in 2D');
  });

  test('quality flags: a scene cut in the window, low-confidence legs, sparse tracking', () => {
    const cut = analyzeSeries(syntheticShot(), 1, { ...W, cuts: [50] });
    assert.equal(cut.quality.cutInWindow, true);
    assert.equal(cut.quality.usable, false);
    assert.ok(cut.quality.warnings.includes('scene_cut_in_window'));
    const legs = analyzeSeries(syntheticShot({ legConf: 0.1 }), 1, W);
    assert.ok(legs.quality.lowConfidenceJoints.includes('r_knee'));
    assert.ok(legs.quality.warnings.includes('low_confidence_joints'));
    const s = syntheticShot();
    const keep = s.frames.map((_, i) => i).filter((i) => i % 3 === 0 || Math.abs(i - SHOT.release) <= 2);
    const sparse = { ...s, frames: keep.map((i) => s.frames[i]!) } as typeof s;
    const pick = (src: Float32Array, w: number) => Float32Array.from(keep.flatMap((i) => Array.from(src.subarray(i * w, i * w + w))));
    Object.assign(sparse, { kpts2d: pick(s.kpts2d, 34), conf: pick(s.conf, 17), pose3d: pick(s.pose3d, 51), bbox: pick(s.bbox, 4) });
    const q = computeMetrics(sparse, W).quality;
    assert.ok(q.coverage < 0.5 && q.warnings.includes('sparse_tracking'));
  });

  test('nobody near the release is an analysis error', () => {
    assert.throws(() => computeMetrics(syntheticShot({ frames: 40 }), W), AnalysisError);
  });
});

describe('clip npz analysis', () => {
  test('picks the shooter (largest box × confidence) over a bystander, and the pose stays under 64 KB', () => {
    const shooter = syntheticShot();
    const bystander = syntheticShot({ dx: 400, scale: 0.5, conf: 0.95 });
    const npz = writeNpz([{ track: 3, series: bystander }, { track: 8, series: shooter }]);
    const startMs = 1000, releaseMs = startMs + (SHOT.release * 1000) / SHOT.fps, endMs = startMs + 4000;
    const a = analyzeClipNpz(npz, { releaseMs, startMs, endMs });
    assert.equal(a.shooterTrack, 8);
    assert.equal(pickShooter(poseArraysFromNpz(npz), SHOT.release)!.track, 8);
    near(a.metrics.elbowAngleReleaseDeg, SHOT.elbowRelease, 0.5, 'release elbow');
    const size = Buffer.byteLength(JSON.stringify(a));
    assert.ok(size < 64 * 1024, `analysis is ${size} bytes`);
    // Recomputing from the stored compact pose gives the same numbers.
    assert.deepEqual(recompute(JSON.parse(JSON.stringify(a))).metrics, a.metrics);
    assert.deepEqual(recompute(a).quality, a.quality);
  });

  test('a 60 fps clip still fits the 64 KB budget', () => {
    const s = syntheticShot({ frames: 240 });
    s.fps = 60;
    const a = analyzeClipNpz(writeNpz([{ track: 1, series: s }], { fps: 60 }), { releaseMs: 1500, startMs: 0, endMs: 4000 });
    assert.ok(Buffer.byteLength(JSON.stringify(a)) < 64 * 1024);
  });

  test('the sample: metrics recomputed from the compact pose match those from the full npz', { skip: !haveSample && 'sample npz not present' }, () => {
    const bytes = readFileSync(SAMPLE);
    const a = analyzeClipNpz(bytes, { startMs: 0, releaseMs: 3000, endMs: 4000 });
    assert.ok(Buffer.byteLength(JSON.stringify(a)) < 64 * 1024);
    assert.deepEqual(recompute(JSON.parse(JSON.stringify(a))).metrics, a.metrics);
  });
});

describe('reference candidate detector', () => {
  test('finds the synthetic jump shot once per track, and skips a window with a cut', () => {
    const long = syntheticShot({ frames: 300, frameOffset: 0 });
    const p = poseArraysFromNpz(writeNpz([{ track: 1, series: long }]));
    const found = detectCandidates(p);
    assert.ok(found.length >= 1, 'found the shot');
    assert.ok(found.some((c) => Math.abs(c.releaseFrame - SHOT.release) <= 3 && c.track === 1 && c.hand === 'right'));
    const withCut = poseArraysFromNpz(writeNpz([{ track: 1, series: long }], { cuts: [SHOT.release - 10] }));
    assert.ok(!detectCandidates(withCut).some((c) => Math.abs(c.releaseFrame - SHOT.release) <= 3));
  });

  test('on the sample broadcast clip', { skip: !haveSample && 'sample npz not present' }, () => {
    const p = poseArraysFromNpz(readFileSync(SAMPLE));
    const c = detectCandidates(p);
    console.log(`# reference detector: ${c.length} candidate shots on the sample`);
    assert.equal(c.length, 7); // pinned so a detector change is a deliberate one
    for (const x of c) {
      assert.ok(!p.cuts.some((cut) => cut > x.releaseFrame - 90 && cut <= x.releaseFrame + 30), 'no cut inside the window');
      assert.ok(Buffer.byteLength(JSON.stringify(x.analysis)) < 64 * 1024);
    }
  });
});
