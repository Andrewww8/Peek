import { NETWORK } from './config';
import { BackendError } from './errors';
import type { AuthPort, Platform } from './ports';
import { computeStats, OUTCOMES, type Outcome, type ShotStats } from './stats';

/** Upload state of a shot's cloud clip; see migration v3 in schema.ts. */
export type ClipState = 'local_only' | 'pending' | 'cutting' | 'synced' | 'outcome_dirty' | 'unavailable';

export interface Shot {
  sessionId: string;
  shotNumber: number;
  releaseMs: number;
  outcome: Outcome;
  clipState: ClipState;
}

interface ShotRow {
  session_id: string;
  shot_number: number;
  release_ms: number;
  outcome: Outcome;
  clip_state: ClipState;
}

const fromRow = (r: ShotRow): Shot => ({
  sessionId: r.session_id,
  shotNumber: Number(r.shot_number),
  releaseMs: Number(r.release_ms),
  outcome: r.outcome,
  clipState: r.clip_state,
});

/**
 * Only shots tagged while signed in ever upload. A null token is a definite
 * "signed out" → local_only, kept on the phone for good, even after a later
 * sign-in. A probe that errors or outlasts authProbeMs means a stored session
 * exists (refreshing), so the shot is pending.
 */
async function clipStateForNewShot(auth: AuthPort): Promise<ClipState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await Promise.race([
      auth.getAccessToken(),
      new Promise<'slow'>((resolve) => (timer = setTimeout(() => resolve('slow'), NETWORK.authProbeMs))),
    ]);
    return token === null ? 'local_only' : 'pending';
  } catch {
    return 'pending';
  } finally {
    clearTimeout(timer);
  }
}

export class ShotStore {
  /** addShot and deleteShot run one at a time; see addShot. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly p: Platform) {}

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writes.then(op);
    this.writes = run.catch(() => undefined);
    return run;
  }

  /**
   * Marks a release timestamp in replay; starts unmarked until the player tags it.
   *
   * Numbering is one INSERT … SELECT statement, so it is atomic without a
   * JS-level transaction: expo-sqlite's withTransactionAsync does not
   * serialize, so two quick taps would nest BEGINs on the shared connection.
   * The number comes from the session's monotonic counter, which a trigger
   * advances inside the same statement, so a deleted shot's number is never
   * reused. Selecting from `sessions` makes a missing session insert no row
   * (→ not_found) without depending on FK error text.
   *
   * The insert goes through run() without RETURNING, so it commits within one
   * bridge call. first() with RETURNING would leave the write statement active
   * until a later finalize call, holding the connection's transaction open.
   * The new row is then read back by rowid. The insert and the read-back run
   * under this store's write lock together with deleteShot, so no other shot
   * insert or delete lands between them: the rowid cannot be freed and handed
   * to another shot before it is read.
   */
  async addShot(sessionId: string, releaseMs: number, outcome: Outcome = 'unmarked'): Promise<Shot> {
    if (!Number.isFinite(releaseMs) || releaseMs < 0) throw new BackendError('invalid_input', 'releaseMs must be >= 0');
    if (!OUTCOMES.includes(outcome)) throw new BackendError('invalid_input', `Unknown outcome ${outcome}`);
    const clipState = await clipStateForNewShot(this.p.auth);
    return this.serial(() => this.insertShot(sessionId, Math.round(releaseMs), outcome, clipState));
  }

  private async insertShot(sessionId: string, releaseMs: number, outcome: Outcome, clipState: ClipState): Promise<Shot> {
    const { changes, lastInsertRowId } = await this.p.db.run(
      `INSERT INTO shots (session_id, shot_number, release_ms, outcome, clip_state)
       SELECT id, last_shot_number + 1, ?, ?, ?
       FROM sessions WHERE id = ?`,
      [releaseMs, outcome, clipState, sessionId],
    );
    if (changes === 0) throw new BackendError('not_found', `No session ${sessionId}`);
    const row = await this.p.db.first<ShotRow>('SELECT * FROM shots WHERE rowid = ? AND session_id = ?', [
      lastInsertRowId,
      sessionId,
    ]);
    // Only if the shot was deleted again before the read-back.
    if (!row) throw new BackendError('not_found', `Shot for session ${sessionId} was removed`);
    return fromRow(row);
  }

  /**
   * Tag or re-tag a shot. Totals are derived on read, so they always reflect
   * the latest edit. A synced clip whose outcome really changes is marked for
   * a PATCH in the same statement. A pending or cutting shot needs nothing:
   * the sync compares the outcome it sent when it marks the shot.
   */
  async setOutcome(sessionId: string, shotNumber: number, outcome: Outcome): Promise<void> {
    if (!OUTCOMES.includes(outcome)) throw new BackendError('invalid_input', `Unknown outcome ${outcome}`);
    const { changes } = await this.p.db.run(
      `UPDATE shots
          SET outcome = ?,
              clip_state = CASE WHEN clip_state = 'synced' AND outcome <> ? THEN 'outcome_dirty' ELSE clip_state END
        WHERE session_id = ? AND shot_number = ?`,
      [outcome, outcome, sessionId, shotNumber],
    );
    if (changes === 0) throw new BackendError('not_found', `No shot ${sessionId}#${shotNumber}`);
  }

  /** A trigger queues the remote DELETE in the same statement when the server may hold the clip. */
  async deleteShot(sessionId: string, shotNumber: number): Promise<void> {
    await this.serial(() =>
      this.p.db.run('DELETE FROM shots WHERE session_id = ? AND shot_number = ?', [sessionId, shotNumber]),
    );
  }

  async list(sessionId: string): Promise<Shot[]> {
    const rows = await this.p.db.all<ShotRow>(
      'SELECT * FROM shots WHERE session_id = ? ORDER BY shot_number',
      [sessionId],
    );
    return rows.map(fromRow);
  }

  async stats(sessionId: string): Promise<ShotStats> {
    return this.aggregate('WHERE session_id = ?', [sessionId]);
  }

  /** Totals across all sessions of a shot type (history view). */
  async overall(shotType: string): Promise<ShotStats> {
    return this.aggregate('WHERE session_id IN (SELECT id FROM sessions WHERE shot_type = ?)', [shotType]);
  }

  private async aggregate(where: string, params: string[]): Promise<ShotStats> {
    const r = await this.p.db.first<{ made: number; missed: number; unmarked: number }>(
      `SELECT COALESCE(SUM(outcome = 'made'), 0) AS made,
              COALESCE(SUM(outcome = 'missed'), 0) AS missed,
              COALESCE(SUM(outcome = 'unmarked'), 0) AS unmarked
       FROM shots ${where}`,
      params,
    );
    return computeStats({ made: Number(r?.made ?? 0), missed: Number(r?.missed ?? 0), unmarked: Number(r?.unmarked ?? 0) });
  }
}
