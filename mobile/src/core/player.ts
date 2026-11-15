import { BackendError } from './errors';
import type { Platform } from './ports';

/** The player's declared shooting hand; null lets the API detect it from pose. */
export type ShootingHand = 'R' | 'L';

const HAND_KEY = 'shooting_hand';

/**
 * Local player settings, kept in SQLite (works offline and signed out).
 * Each write is one statement. ClipSync sends the hand with every clips POST.
 */
export class PlayerSettings {
  constructor(private readonly p: Platform) {}

  async getShootingHand(): Promise<ShootingHand | null> {
    return readShootingHand(this.p);
  }

  async setShootingHand(hand: ShootingHand | null): Promise<void> {
    if (hand !== null && hand !== 'R' && hand !== 'L') {
      throw new BackendError('invalid_input', `shootingHand must be 'R', 'L' or null, got ${String(hand)}`);
    }
    await this.p.db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [HAND_KEY, hand],
    );
  }
}

export async function readShootingHand(p: Platform): Promise<ShootingHand | null> {
  const row = await p.db.first<{ value: string | null }>('SELECT value FROM settings WHERE key = ?', [HAND_KEY]);
  return row?.value === 'R' || row?.value === 'L' ? row.value : null;
}
