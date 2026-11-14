import type { ApiClient } from './apiClient';
import { NETWORK } from './config';
import { BackendError, type BackendErrorCode } from './errors';
import { extensionOf, toDocumentUri } from './paths';
import { readShootingHand } from './player';
import type { Platform } from './ports';
import type { ClipState } from './shots';

export interface ClipSyncReport {
  /** Shots whose clip the API confirmed during this run. */
  uploaded: number;
  /** Outcome PATCHes applied. */
  patched: number;
  /** Remote DELETEs completed (one per shot, or one per session). */
  deleted: number;
  /** Shots marked unavailable during this run (nothing left to cut, or the API refused them). */
  unavailable: number;
  /** Shots still waiting to upload (pending or cutting) after the run. */
  pending: number;
  /** Pending shots set to local_only because nobody was signed in. */
  skippedSignedOut: number;
  /**
   * Sessions with synced shots whose API copy has not received the current
   * shooting hand yet. Their next clips POST carries it; a session with no
   * pending shots waits for that (see ClipSync).
   */
  handPending: number;
  /** Codes of the failures met; the affected work stays queued for the next run. */
  errors: BackendErrorCode[];
}

/** After one of these, the rest of the run would fail the same way. */
const STOP_RUN = new Set<BackendErrorCode>(['unauthorized', 'unreachable', 'timeout', 'not_configured']);
const WAITING: ClipState[] = ['pending', 'cutting'];

const CONTENT_TYPES: Record<string, string> = { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v' };

/** A 4xx the API will give again for the same recording (too large, too long, bad request). */
const isPermanent = (err: unknown) =>
  err instanceof BackendError &&
  err.code === 'http_error' &&
  err.status !== undefined &&
  err.status >= 400 &&
  err.status < 500 &&
  ![404, 408, 409, 425, 429].includes(err.status);

const codeOfSync = (err: unknown): BackendErrorCode => (err instanceof BackendError ? err.code : 'sync_failed');

class StopRun extends Error {}

/**
 * Uploads tagged shots of signed-in players to the cloud API.
 *
 * Per session with waiting shots: request an upload URL, PUT the recording,
 * mark its pending shots `cutting`, POST them for cutting, then mark each
 * returned shot synced (or outcome_dirty if its outcome changed meanwhile) in
 * one statement per shot. Then PATCH dirty outcomes and flush queued DELETEs.
 *
 * Crash safety: every local state change is one SQL statement, and every
 * remote call is idempotent (a re-POST upserts per shot; PATCH and DELETE
 * repeat harmlessly), so a kill anywhere costs at most a repeated upload or
 * call. `cutting` records that the server may hold a clip: a kill before the
 * shot is marked leaves it cutting (retried like pending), and deleting it
 * queues a remote DELETE through the same trigger as a synced shot.
 *
 * Never throws, never runs twice at once (a second call joins the first), and
 * touches only the network and short single-statement SQL, so recording,
 * tagging and replay never wait on it.
 */
export class ClipSync {
  private running: Promise<ClipSyncReport> | null = null;

  constructor(
    private readonly p: Platform,
    private readonly api: ApiClient,
  ) {}

  syncNow(): Promise<ClipSyncReport> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<ClipSyncReport> {
    const report: ClipSyncReport = {
      uploaded: 0,
      patched: 0,
      deleted: 0,
      unavailable: 0,
      pending: 0,
      skippedSignedOut: 0,
      handPending: 0,
      errors: [],
    };
    try {
      await this.work(report);
    } catch (err) {
      if (!(err instanceof StopRun)) report.errors.push(codeOfSync(err));
    }
    try {
      const r = await this.p.db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM shots WHERE clip_state IN ('pending', 'cutting')`,
      );
      report.pending = Number(r?.n ?? 0);
      const hand = await readShootingHand(this.p);
      if (hand !== null) {
        const h = await this.p.db.first<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sessions
            WHERE (shooting_hand_sent IS NULL OR shooting_hand_sent <> ?)
              AND id IN (SELECT session_id FROM shots WHERE clip_state IN ('synced', 'outcome_dirty'))`,
          [hand],
        );
        report.handPending = Number(h?.n ?? 0);
      }
    } catch (err) {
      report.errors.push(codeOfSync(err));
    }
    return report;
  }

  private async work(report: ClipSyncReport) {
    const { db } = this.p;
    if (!this.api.baseUrl) {
      report.errors.push('not_configured');
      return;
    }
    let token: string | null;
    try {
      token = await this.p.auth.getAccessToken();
    } catch (err) {
      report.errors.push(codeOfSync(err));
      return;
    }
    if (token === null) {
      // Signed out: nothing leaves the phone and nothing waits for a later
      // sign-in (possibly by someone else). Shots already sent for cutting
      // stay cutting; their clips may exist under the account that sent them.
      const { changes } = await db.run(`UPDATE shots SET clip_state = 'local_only' WHERE clip_state = 'pending'`);
      report.skippedSignedOut = changes;
      return;
    }

    // Nothing left to cut: the player removed the video before its clips synced.
    report.unavailable += (
      await db.run(
        `UPDATE shots SET clip_state = 'unavailable'
          WHERE clip_state IN ('pending', 'cutting')
            AND session_id IN (SELECT id FROM sessions WHERE video_path IS NULL)`,
      )
    ).changes;

    const fail = (err: unknown) => {
      const code = codeOfSync(err);
      report.errors.push(code);
      if (STOP_RUN.has(code)) throw new StopRun();
    };

    const sessions = await db.all<{ id: string; shot_type: string; video_path: string; duration_ms: number | null }>(
      `SELECT id, shot_type, video_path, duration_ms FROM sessions
        WHERE video_path IS NOT NULL
          AND id IN (SELECT session_id FROM shots WHERE clip_state IN ('pending', 'cutting'))
        ORDER BY created_at, id`,
    );
    for (const s of sessions) {
      try {
        await this.uploadSession(token, s, report);
      } catch (err) {
        if (isPermanent(err)) report.unavailable += await this.markSessionUnavailable(s.id);
        fail(err);
      }
    }

    const dirty = await db.all<{ session_id: string; shot_number: number; outcome: string }>(
      `SELECT session_id, shot_number, outcome FROM shots WHERE clip_state = 'outcome_dirty' ORDER BY session_id, shot_number`,
    );
    for (const d of dirty) {
      try {
        await this.api.patchShotOutcome(token, d.session_id, Number(d.shot_number), d.outcome);
        // Only if the outcome is still the one sent; a newer edit stays dirty.
        const { changes } = await db.run(
          `UPDATE shots SET clip_state = 'synced'
            WHERE session_id = ? AND shot_number = ? AND clip_state = 'outcome_dirty' AND outcome = ?`,
          [d.session_id, d.shot_number, d.outcome],
        );
        if (changes > 0) report.patched++;
      } catch (err) {
        if (err instanceof BackendError && err.code === 'not_found') {
          // The API holds no clip for it any more: nothing to patch.
          report.unavailable += (
            await db.run(
              `UPDATE shots SET clip_state = 'unavailable'
                WHERE session_id = ? AND shot_number = ? AND clip_state = 'outcome_dirty'`,
              [d.session_id, d.shot_number],
            )
          ).changes;
          continue;
        }
        fail(err);
      }
    }

    const deletes = await db.all<{ session_id: string; shot_number: number }>(
      'SELECT session_id, shot_number FROM clip_deletes ORDER BY session_id, shot_number',
    );
    const sessionsDone = new Set<string>();
    for (const d of deletes) {
      if (sessionsDone.has(d.session_id)) continue;
      const shotNumber = Number(d.shot_number);
      try {
        if (shotNumber === 0) await this.api.deleteSessionClips(token, d.session_id);
        else await this.api.deleteShotClip(token, d.session_id, shotNumber);
      } catch (err) {
        // Idempotent: already gone counts as done.
        if (!(err instanceof BackendError && err.code === 'not_found')) {
          fail(err);
          continue;
        }
      }
      if (shotNumber === 0) {
        // The session-wide DELETE covers every clip of the session.
        sessionsDone.add(d.session_id);
        await db.run('DELETE FROM clip_deletes WHERE session_id = ?', [d.session_id]);
      } else {
        await db.run('DELETE FROM clip_deletes WHERE session_id = ? AND shot_number = ?', [d.session_id, shotNumber]);
      }
      report.deleted++;
    }
  }

  private async uploadSession(
    token: string,
    s: { id: string; shot_type: string; video_path: string; duration_ms: number | null },
    report: ClipSyncReport,
  ) {
    const { db, files } = this.p;
    const uri = toDocumentUri(files, s.video_path);
    const info = await files.info(uri);
    if (!info.exists || !info.size) {
      report.unavailable += await this.markSessionUnavailable(s.id);
      return;
    }
    const ext = extensionOf(s.video_path);
    const upload = await this.api.createRecordingUpload(token, {
      sessionId: s.id,
      ext,
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      sizeBytes: info.size,
      durationMs: s.duration_ms === null ? null : Number(s.duration_ms),
    });
    let status: number;
    try {
      ({ status } = await files.upload(upload.uploadUrl, uri, {
        method: 'PUT',
        headers: upload.headers,
        timeoutMs: NETWORK.recordingUploadTimeoutMs,
      }));
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      throw new BackendError(/timed? ?out/i.test(message) ? 'timeout' : 'unreachable', `Recording upload failed: ${message}`);
    }
    if (status < 200 || status >= 300) {
      throw new BackendError('http_error', `HTTP ${status} uploading the recording of ${s.id}`, status);
    }

    // From here the server may cut clips: a delete must reach it too.
    await db.run(`UPDATE shots SET clip_state = 'cutting' WHERE session_id = ? AND clip_state = 'pending'`, [s.id]);
    const shots = await db.all<{ shot_number: number; release_ms: number; outcome: string }>(
      `SELECT shot_number, release_ms, outcome FROM shots
        WHERE session_id = ? AND clip_state = 'cutting' ORDER BY shot_number`,
      [s.id],
    );
    if (shots.length === 0) return;
    const sent = shots.map((r) => ({ shotNumber: Number(r.shot_number), releaseMs: Number(r.release_ms), outcome: r.outcome }));
    // Read the hand just before the POST; record afterwards exactly what was sent,
    // so a change made meanwhile still counts as not delivered.
    const hand = await readShootingHand(this.p);
    const clips = await this.api.createClips(token, upload.uploadId, {
      sessionId: s.id,
      shotType: s.shot_type,
      shots: sent,
      ...(hand ? { shootingHand: hand } : {}),
    });
    if (hand) await db.run('UPDATE sessions SET shooting_hand_sent = ? WHERE id = ?', [hand, s.id]);
    // Ok only when every entry for the shot is a cut clip; an error entry wins.
    const cut = new Set(clips.filter((c) => c.ok).map((c) => c.shotNumber));
    for (const c of clips) if (!c.ok) cut.delete(c.shotNumber);
    for (const shot of sent) {
      if (cut.has(shot.shotNumber)) {
        // One statement: synced if the outcome is still the one sent, else dirty (needs a PATCH).
        const { changes } = await db.run(
          `UPDATE shots SET clip_state = CASE WHEN outcome = ? THEN 'synced' ELSE 'outcome_dirty' END
            WHERE session_id = ? AND shot_number = ? AND clip_state = 'cutting'`,
          [shot.outcome, s.id, shot.shotNumber],
        );
        if (changes > 0) report.uploaded++;
      } else {
        // A per-shot error (release_beyond_duration or any other) or no entry at
        // all: the API will not cut it, and retrying would re-upload forever.
        report.unavailable += (
          await db.run(
            `UPDATE shots SET clip_state = 'unavailable' WHERE session_id = ? AND shot_number = ? AND clip_state = 'cutting'`,
            [s.id, shot.shotNumber],
          )
        ).changes;
      }
    }
  }

  private async markSessionUnavailable(sessionId: string): Promise<number> {
    const { changes } = await this.p.db.run(
      `UPDATE shots SET clip_state = 'unavailable' WHERE session_id = ? AND clip_state IN (${WAITING.map((w) => `'${w}'`).join(', ')})`,
      [sessionId],
    );
    return changes;
  }
}
