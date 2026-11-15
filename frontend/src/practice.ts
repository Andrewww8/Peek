export const SHOT_TYPE = 'three_point';
export const DRILL_NAME = 'Catch-and-shoot three';
export const PRACTICE_TIP = 'Hold your finish until the ball reaches the rim.';
export const RECORD_LIMIT_SECONDS = 30;
export const RECORD_MAX_BYTES = 20_000_000;
export const STORAGE_RESERVE_BYTES = 12_000_000;

export type ShotOutcome = 'made' | 'missed' | 'unmarked';
export type ShootingHand = 'left' | 'right';

export type Session = {
  id: string;
  createdAt: number;
  shotType: typeof SHOT_TYPE;
  videoPath: string | null;
  durationMs: number;
  sizeBytes: number;
};

export type Shot = {
  shotNumber: number;
  releaseMs: number;
  outcome: ShotOutcome;
};

export function shotStats(shots: readonly Pick<Shot, 'outcome'>[]) {
  const makes = shots.filter(({ outcome }) => outcome === 'made').length;
  const misses = shots.filter(({ outcome }) => outcome === 'missed').length;
  const attempts = makes + misses;
  return {
    makes,
    attempts,
    unmarked: shots.length - attempts,
    percentage: attempts ? Math.round((makes / attempts) * 100) : null,
  };
}

export function clipTime(milliseconds: number, showTenths = false) {
  const tenths = Math.floor(Math.max(0, milliseconds) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = String(Math.floor(tenths / 10) % 60).padStart(2, '0');
  return `${minutes}:${seconds}${showTenths ? `.${tenths % 10}` : ''}`;
}

export function sessionDate(milliseconds: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(milliseconds);
}

export function sessionDay(milliseconds: number) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(milliseconds);
}

export function sessionTime(milliseconds: number) {
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(milliseconds);
  return sessionDay(milliseconds) + ' · ' + time;
}
