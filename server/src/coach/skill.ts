/**
 * Form skills loaded into the agent's in-memory filesystem: one per shot type.
 * The cues and drills are hand-written. Every number comes from the pro calibration
 * (pro-baselines.generated.ts, written by scripts/calibrate-coach.ts).
 */
import type { ReleaseMetricKey } from '../cv/release.js';
import type { ShotTypeBaseline } from './calibration.js';
import { PRO_BASELINES } from './pro-baselines.generated.js';

export const SHOT_TYPE_LABELS: Record<string, string> = { three_point: 'catch-and-shoot three-pointer', midrange: 'midrange jump shot' };
export const SKILL_NAMES: Record<string, string> = { three_point: 'three-point-form', midrange: 'midrange-form' };
export const skillPath = (shotType: string) => `/skills/${SKILL_NAMES[shotType] ?? 'three-point-form'}/SKILL.md`;
/** Kept for callers of the first version. */
export const SKILL_PATH = skillPath('three_point');

const METRIC_TEXT: Record<ReleaseMetricKey, string> = {
  releaseElbowDeg: 'Shooting-elbow angle at release (180° = straight).',
  setPointElbowDeg: 'Most-flexed elbow in the 0.6 s before release, with the wrist above the shoulder (the set point).',
  kneeDipDeg: 'Smallest knee angle before release (the dip; smaller = deeper).',
  dipToReleaseMs: 'Time from the bottom of the dip to release.',
  releaseHeight: 'Shooting wrist above the head at release, in body heights.',
  trunkLeanDeg: 'Trunk tilt from vertical at release.',
  elbowFlare: 'Elbow outside the wrist at the set point, per upper-arm length (0 = elbow under the ball).',
  followThroughHoldMs: 'Time after release with the wrist above the shoulder and the elbow still extended (max 400 ms in the window).',
  pelvisRisePeak: 'Highest pelvis rise in the window, in body heights (the jump).',
  wristSnapDeg: 'Wrist flexion after release (fingertips over the rim). Pro templates only: phone clips have no finger tracking.',
  stanceWidth: 'Heel spread per shoulder width during the load. Pro templates only.',
  footTurnDeg: 'Toes turned away from straight ahead during the load. Pro templates only.',
};

/** The generated "pro ranges" section of a skill. */
export function renderThresholds(shotType: string, b: ShotTypeBaseline | undefined = PRO_BASELINES[shotType]): string {
  if (!b) return '_No pro templates for this shot type yet._\n';
  const rows = (Object.keys(METRIC_TEXT) as ReleaseMetricKey[])
    .filter((k) => b.metrics[k])
    .map((k) => {
      const m = b.metrics[k]!;
      return `| ${k} | ${METRIC_TEXT[k]} | ${m.mean} ± ${m.sd} | ${m.min} – ${m.max} |`;
    });
  return [
    `Calibrated from ${b.templates} averaged pro templates (${b.shotsAveraged} pro shots, weighted by shots averaged).`,
    'Use these as the healthy range for the player\'s pro-comparable metrics (compare_to_reference returns z-scores against them).',
    'About ±1 sd is typical pro variation; outside the min–max is unusual even among these pros.',
    '',
    '| Metric | Meaning | Pro mean ± sd | Pro range |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

const CUES = `## Cues and drills (hand-written)

### Set point (setPointElbowDeg)
- Cue: "Load the ball just above your shooting eye, elbow under the ball."
- Drill: one-hand form shooting close to the rim, then step back.

### Release (releaseElbowDeg, releaseHeight)
- Cue: "Reach up and out, finish tall."
- Drill: wall-shadow or chair shooting, freezing at full extension.

### Elbow alignment (elbowFlare)
- Cue: "Elbow in, point it at the rim."
- Drill: line shooting along a court line, ball and elbow over the line.

### Dip and legs (kneeDipDeg, dipToReleaseMs, pelvisRisePeak)
- Cue: "Dip on the catch, shoot on the way up."
- Drill: catch-and-shoot from a toss, focusing on one smooth motion.

### Balance (trunkLeanDeg, stance)
- Cue: "Land where you took off."
- Drill: tape a landing spot and check you land on it.

### Follow-through (followThroughHoldMs, wristSnapDeg)
- Cue: "Hold your finish until the ball reaches the rim."
- Drill: hold every finish for a count of two, fingers pointing into the rim.

## Using the pros
- Pros differ in style: compare with the pro range and with the closest-matching pros, never "copy one pro".
- Pro numbers are averages of many shots by that player, derived from video. Mention how many shots and any reliability flag.
- Never say a pro does something wrong; say how the player differs from them.

## Data quality
- If a shot's quality is not usable, or warnings include scene_cut_in_window, sparse_tracking or low_confidence, say the measurement may be unreliable.
- A shot without a pro comparison (too little 3D pose) can still be coached from its own metrics and the made/missed tags.
`;

export function renderSkill(shotType: string, b?: ShotTypeBaseline): string {
  const label = SHOT_TYPE_LABELS[shotType] ?? shotType;
  return `---
name: ${SKILL_NAMES[shotType] ?? shotType}
description: Cues, drills and pro-calibrated ranges for a ${label}, mapped to the shot metrics the tools return. Read it before giving form feedback.
---
# ${label[0]!.toUpperCase()}${label.slice(1)}: form

${CUES}
## Pro ranges (generated from data)

${renderThresholds(shotType, b)}`;
}

export const THREE_POINT_FORM_SKILL = renderSkill('three_point');
export const MIDRANGE_FORM_SKILL = renderSkill('midrange');
