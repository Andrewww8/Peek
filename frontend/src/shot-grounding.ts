import type { PoseSample } from './pose-3d.ts';

// Source-image positions, with positive Y up. The torso length shares the image Y scale.
export type JumpSample = readonly [rightAnkle: PoseSample, leftAnkle: PoseSample, pelvis: PoseSample,
  torso: PoseSample];

type Measurement = { frame: number; right: number; left: number; pelvis: number; torso: number };

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return (sorted[middle]! + sorted[Math.ceil(sorted.length / 2) - 1]!) / 2;
}

export function jumpClearance(
  samples: (JumpSample | null)[] | undefined, frameCount: number, release: number, fps: number,
): number[] {
  const clearance = Array<number>(frameCount).fill(0);
  if (!Array.isArray(samples)) return clearance;

  const measurements = samples.slice(0, frameCount).flatMap((sample, frame): Measurement[] => {
    if (!Array.isArray(sample)) return [];
    const [right, left, pelvis, torso] = sample;
    if (right == null || left == null || pelvis == null || torso == null ||
        ![right, left, pelvis, torso].every(Number.isFinite) || torso <= 0) return [];
    return [{ frame, right, left, pelvis, torso }];
  });
  const earlyStance = measurements.filter(({ frame }) => frame >= release - 0.8 * fps && frame <= release - 0.26 * fps);
  // A deep early dip can hide the feet. In that case look for the first visible pre-release stance.
  const stance = earlyStance.length >= 3 ? earlyStance : measurements.filter(({ frame }) => frame <= release - 0.10 * fps).slice(0, 3);
  if (stance.length < 3) return clearance;

  const torso = median(stance.map((sample) => sample.torso));
  const rightAnkle = median(stance.map((sample) => sample.right));
  const leftAnkle = median(stance.map((sample) => sample.left));
  const track = measurements.filter((sample) => Math.abs(sample.torso / torso - 1) <= 0.40).map((sample) => ({
    ...sample,
    bothFeetUp: Math.min(sample.right - rightAnkle, sample.left - leftAnkle) / torso,
    hipAboveFeet: (sample.pelvis - Math.min(sample.right, sample.left)) / torso,
  }));

  // Confirm a short, sustained rise of both feet near release. Extending out of the knee
  // bend also differentiates a jump from a camera bump that moves the entire body together.
  const nearRelease = track.filter(({ frame }) => frame >= release - 0.34 * fps && frame <= release + 0.55 * fps);
  const runs: (typeof track)[] = [];
  let run: typeof track = [];
  for (const sample of nearRelease) {
    if (sample.bothFeetUp <= 0.07 || (run.length && sample.frame - run.at(-1)!.frame > 0.14 * fps)) {
      if (run.length) runs.push(run);
      run = [];
    }
    if (sample.bothFeetUp > 0.07) run.push(sample);
  }
  if (run.length) runs.push(run);

  for (const flight of runs) {
    const start = flight[0]!, end = flight.at(-1)!;
    if (flight.length < 3 || end.frame - start.frame < 0.08 * fps) continue;
    const peak = flight.reduce((highest, sample) => sample.bothFeetUp > highest.bothFeetUp ? sample : highest);
    if (peak.bothFeetUp < 0.14 || peak.frame < release - 0.16 * fps || peak.frame > release + 0.32 * fps) continue;

    const approach = track.filter(({ frame }) => frame >= start.frame - 0.4 * fps && frame < start.frame);
    if (!approach.length || !approach.some(({ bothFeetUp }) => bothFeetUp <= 0.07)) continue;
    const hipLow = Math.min(...approach.map((sample) => sample.pelvis));
    const extensionLow = Math.min(...approach.map((sample) => sample.hipAboveFeet));
    if (peak.pelvis - hipLow < torso * 0.2 || peak.hipAboveFeet - extensionLow < 0.08) continue;

    const afterPeak = track.filter(({ frame }) => frame > peak.frame && frame <= release + 0.68 * fps);
    if (!afterPeak.some(({ bothFeetUp }) => peak.bothFeetUp - bothFeetUp >= Math.max(0.075, peak.bothFeetUp * 0.25))) continue;

    // Convert image clearance relative to torso size to the scaled skeleton's height.
    const height = (sample: typeof peak) => Math.min(0.33, Math.max(0, sample.bothFeetUp - 0.045) * 0.30);
    const before = approach.at(-1)!;
    const after = afterPeak.find((sample) => sample.frame > end.frame);
    const keys = [
      { frame: Math.max(start.frame - Math.ceil(0.10 * fps), before.frame), height: 0 },
      ...flight.map((sample) => ({ frame: sample.frame, height: height(sample) })),
      ...(after ? [{ frame: Math.min(after.frame, end.frame + Math.ceil(0.10 * fps)), height: 0 }] : []),
    ];
    for (let i = 1; i < keys.length; i++) {
      const previous = keys[i - 1]!, current = keys[i]!;
      for (let frame = previous.frame; frame <= current.frame; frame++) {
        const t = (frame - previous.frame) / (current.frame - previous.frame);
        clearance[frame] = previous.height * (1 - t) + current.height * t;
      }
    }
    return clearance;
  }
  return clearance;
}
