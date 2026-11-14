/**
 * Averaged pro shot templates from the CV team (`<Player>_<three|midrange>.npz`).
 * Recognized by `release_index` and `t_seconds`. Read only; see release.ts for the frame.
 */
import { readNpz, scalar, NpzError, type NpyArray } from './npz.js';
import { JOINTS, NJ } from './pose.js';
import {
  EXTREMITIES,
  GRID_FPS,
  GRID_N,
  NE,
  RELEASE_INDEX,
  canonicalQuantized,
  computeCurves,
  computeReleaseMetrics,
  type CompactRelease,
  type Curves,
  type Hand,
  type ReleaseMetrics,
  type ReleaseSeries,
} from './release.js';

export const TEMPLATE_SHOT_TYPES: Record<string, string> = { three: 'three_point', midrange: 'midrange' };
export const LOW_CONFIDENCE_SHOTS = 10;

export function isTemplateNpz(a: Record<string, NpyArray>): boolean {
  return 'release_index' in a && 't_seconds' in a;
}

const str = (a: NpyArray | undefined, name: string) => {
  if (!a || !Array.isArray(a.data) || a.data.length !== 1) throw new NpzError(`${name} must be a string`);
  return a.data[0]!;
};
const shape = (a: NpyArray | undefined, name: string, want: number[]) => {
  if (!a || a.dtype !== '<f4' || a.shape.join() !== want.join()) throw new NpzError(`${name} must be float32 (${want})`);
  return a.data as Float32Array;
};

export interface TemplateFile {
  player: string;
  shotType: string;
  hand: Hand;
  fps: number;
  releaseIndex: number;
  shotsAveraged: number;
  shotsConfidentDistance: number;
  /** As delivered: pelvis-relative body frame, unit body height. */
  series: ReleaseSeries;
}

export function readTemplate(bytes: Uint8Array): TemplateFile {
  const a = readNpz(bytes, { maxUncompressedBytes: 16 * 1024 * 1024 });
  if (!isTemplateNpz(a)) throw new NpzError('not an averaged-shot template (no release_index / t_seconds)');
  const rawType = str(a.shot_type, 'shot_type');
  const shotType = TEMPLATE_SHOT_TYPES[rawType];
  if (!shotType) throw new NpzError(`unknown shot_type ${rawType}`);
  const handRaw = str(a.shooting_hand, 'shooting_hand');
  if (handRaw !== 'R' && handRaw !== 'L') throw new NpzError('shooting_hand must be R or L');
  const fps = scalar(a.fps, 'fps');
  const releaseIndex = scalar(a.release_index, 'release_index');
  const t = a.t_seconds!.data as Float64Array;
  const N = t.length;
  if (fps !== GRID_FPS || releaseIndex !== RELEASE_INDEX || N !== GRID_N || Math.abs(t[releaseIndex]!) > 1e-6) {
    throw new NpzError(`template grid must be ${GRID_FPS} fps, ${GRID_N} frames, release at index ${RELEASE_INDEX}`);
  }
  if ((a.joint_names?.data as string[] | undefined)?.join() !== JOINTS.join()) throw new NpzError('joint_names are not in H36M order');
  if ((a.extremity_names?.data as string[] | undefined)?.join() !== EXTREMITIES.join()) throw new NpzError('unexpected extremity_names');
  return {
    player: str(a.player, 'player'),
    shotType,
    hand: handRaw === 'R' ? 'right' : 'left',
    fps,
    releaseIndex,
    shotsAveraged: scalar(a.shots_averaged, 'shots_averaged'),
    shotsConfidentDistance: scalar(a.shots_with_confident_distance, 'shots_with_confident_distance'),
    series: {
      fps,
      releaseIndex,
      hand: handRaw === 'R' ? 'right' : 'left',
      pose: shape(a.pose3d, 'pose3d', [N, NJ, 3]),
      extremities: shape(a.extremities3d, 'extremities3d', [N, NE, 3]),
      pelvisRise: shape(a.pelvis_rise, 'pelvis_rise', [N]),
      spread: shape(a.joint_spread, 'joint_spread', [N, NJ]),
    },
  };
}

export interface TemplateRecord {
  player: string;
  shotType: string;
  shootingHand: Hand;
  fps: number;
  releaseIndex: number;
  shotsAveraged: number;
  shotsConfidentDistance: number;
  metrics: ReleaseMetrics;
  curves: Curves;
  template: CompactRelease;
  sourceFile: string;
  lowConfidence: boolean;
  uncertainDistance: boolean;
}

/** Everything stored per template, computed with the same engine as player clips. */
export function buildTemplateRecord(bytes: Uint8Array, sourceFile: string): TemplateRecord {
  const t = readTemplate(bytes);
  const c = canonicalQuantized(t.series);
  if (!c) throw new NpzError(`${sourceFile}: no usable 3D pose near release`);
  return {
    player: t.player,
    shotType: t.shotType,
    shootingHand: t.hand,
    fps: t.fps,
    releaseIndex: t.releaseIndex,
    shotsAveraged: t.shotsAveraged,
    shotsConfidentDistance: t.shotsConfidentDistance,
    metrics: computeReleaseMetrics(c.series),
    curves: computeCurves(c.series),
    template: c.compact,
    sourceFile,
    lowConfidence: t.shotsAveraged < LOW_CONFIDENCE_SHOTS,
    uncertainDistance: t.shotsConfidentDistance === 0,
  };
}
