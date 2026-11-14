export type Outcome = 'made' | 'missed' | 'unmarked';
export const OUTCOMES: readonly Outcome[] = ['made', 'missed', 'unmarked'];

export interface ShotStats {
  made: number;
  missed: number;
  /** Shown separately; never counted as attempts. */
  unmarked: number;
  /** made + missed */
  attempts: number;
  /** made / (made + missed), 0..1; null when there are no tagged attempts (empty state). */
  percentage: number | null;
}

export function computeStats(c: { made: number; missed: number; unmarked: number }): ShotStats {
  const attempts = c.made + c.missed;
  return { ...c, attempts, percentage: attempts === 0 ? null : c.made / attempts };
}
