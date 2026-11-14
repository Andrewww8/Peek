import { DEFAULT_SHOT_TYPE, DIRS, FREE_SPACE_HEADROOM_BYTES, RECORDING } from './config';
import { BackendError } from './errors';
import { extensionOf, toDocumentUri, TRASH_SEPARATOR, trashDirUri } from './paths';
import type { Platform } from './ports';
import { computeStats, type ShotStats } from './stats';

export interface Session {
  id: string;
  createdAt: number;
  shotType: string;
  /** Relative to documentUri; null once the player removed the video. */
  videoPath: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
}

export interface SessionWithStats extends Session {
  stats: ShotStats;
}

export type ReplaySource = { state: 'available'; uri: string } | { state: 'unavailable'; reason: 'removed' | 'missing' };

interface SessionRow {
  id: string;
  created_at: number;
  shot_type: string;
  video_path: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
}

const fromRow = (r: SessionRow): Session => ({
  id: r.id,
  createdAt: r.created_at,
  shotType: r.shot_type,
  videoPath: r.video_path,
  durationMs: r.duration_ms,
  sizeBytes: r.size_bytes,
});

export class SessionStore {
  /** Camera temp files with a save in progress. */
  private saving = new Set<string>();

  constructor(private readonly p: Platform) {}

  /** Call before starting the camera. */
  async checkRecordingSpace() {
    const freeBytes = await this.p.files.freeBytes();
    const requiredBytes = RECORDING.reserveBytes + FREE_SPACE_HEADROOM_BYTES;
    return { ok: freeBytes >= requiredBytes, freeBytes, requiredBytes };
  }

  /**
   * Moves a finished camera recording out of the temporary cache into
   * persistent storage, then writes its session row. One video per session.
   */
  async saveRecording(input: { tempUri: string; durationMs: number; shotType?: string }): Promise<Session> {
    if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
      throw new BackendError('invalid_input', 'durationMs must be a non-negative number');
    }
    // A second save of the same clip (double tap) must not race the first one
    // for the file: it is reported as already gone and leaves nothing behind.
    if (this.saving.has(input.tempUri)) {
      throw new BackendError('recording_missing', 'This recording is already being saved');
    }
    this.saving.add(input.tempUri);
    try {
      return await this.saveRecordingNow(input);
    } finally {
      this.saving.delete(input.tempUri);
    }
  }

  private async saveRecordingNow(input: { tempUri: string; durationMs: number; shotType?: string }): Promise<Session> {
    const { files, db } = this.p;
    const tmp = await files.info(input.tempUri);
    if (!tmp.exists) throw new BackendError('recording_missing', 'Camera recording is no longer in the cache');

    const id = this.p.newId();
    const videoPath = `${DIRS.videos}${id}.${extensionOf(input.tempUri)}`;
    const dest = toDocumentUri(files, videoPath);
    await files.ensureDir(toDocumentUri(files, DIRS.videos));
    try {
      await files.move(input.tempUri, dest);
    } catch (err) {
      // The clip vanished between the check and the move (saved elsewhere, or
      // purged). A failed move leaves nothing at dest.
      if (!(await files.info(input.tempUri)).exists) {
        throw new BackendError('recording_missing', 'Camera recording is no longer in the cache');
      }
      throw err;
    }
    const moved = await files.info(dest);

    const session: Session = {
      id,
      createdAt: this.p.now(),
      shotType: input.shotType ?? DEFAULT_SHOT_TYPE,
      videoPath,
      durationMs: Math.round(Math.min(input.durationMs, RECORDING.maxDurationMs)),
      sizeBytes: moved.size,
    };
    try {
      await db.run(
        'INSERT INTO sessions (id, created_at, shot_type, video_path, duration_ms, size_bytes) VALUES (?, ?, ?, ?, ?, ?)',
        [session.id, session.createdAt, session.shotType, session.videoPath, session.durationMs, session.sizeBytes],
      );
    } catch (err) {
      // Put the clip back where the caller can retry instead of orphaning it.
      await files.move(dest, input.tempUri).catch(() => undefined);
      throw err;
    }
    return session;
  }

  async get(id: string): Promise<Session | null> {
    const row = await this.p.db.first<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id]);
    return row ? fromRow(row) : null;
  }

  /** Saved Clips list, newest first, with per-session shot totals. */
  async listWithStats(): Promise<SessionWithStats[]> {
    const rows = await this.p.db.all<SessionRow & { made: number; missed: number; unmarked: number }>(
      `SELECT s.*,
         COALESCE(SUM(sh.outcome = 'made'), 0)     AS made,
         COALESCE(SUM(sh.outcome = 'missed'), 0)   AS missed,
         COALESCE(SUM(sh.outcome = 'unmarked'), 0) AS unmarked
       FROM sessions s LEFT JOIN shots sh ON sh.session_id = s.id
       GROUP BY s.id
       ORDER BY s.created_at DESC, s.id`,
    );
    return rows.map((r) => ({
      ...fromRow(r),
      stats: computeStats({ made: Number(r.made), missed: Number(r.missed), unmarked: Number(r.unmarked) }),
    }));
  }

  /** What the replay screen should show. Missing files degrade to the unavailable state. */
  async replaySource(id: string): Promise<ReplaySource> {
    const s = await this.get(id);
    if (!s) throw new BackendError('not_found', `No session ${id}`);
    if (!s.videoPath) return { state: 'unavailable', reason: 'removed' };
    const uri = toDocumentUri(this.p.files, s.videoPath);
    return (await this.p.files.info(uri)).exists ? { state: 'available', uri } : { state: 'unavailable', reason: 'missing' };
  }

  /**
   * Reclaims space while keeping the session and its shot stats.
   *
   * The file goes to the trash before the row changes, so a kill at any point
   * leaves either the row still pointing at its video (recovery moves it back
   * from the trash) or the row cleared and the file in the trash (recovery
   * empties it). A removed video never sits in videos/ unreferenced, where
   * recovery would adopt it as a session.
   */
  async removeVideo(id: string): Promise<{ reclaimedBytes: number }> {
    const s = await this.get(id);
    if (!s) throw new BackendError('not_found', `No session ${id}`);
    if (!s.videoPath) return { reclaimedBytes: 0 };
    const videoPath = s.videoPath;
    const info = await this.p.files.info(toDocumentUri(this.p.files, videoPath));
    const trashed = await this.trashVideo(videoPath);
    // Only the call that actually cleared the path reports the space (repeated taps).
    const { changes } = await this.restoreOnError(trashed, videoPath, () =>
      this.p.db.run('UPDATE sessions SET video_path = NULL, size_bytes = NULL WHERE id = ? AND video_path = ?', [
        id,
        videoPath,
      ]),
    );
    if (trashed) await this.p.files.remove(trashed);
    return { reclaimedBytes: changes > 0 ? (info.size ?? 0) : 0 };
  }

  /** Deletes the session, its shots and its video. Same trash-first order as removeVideo. */
  async deleteSession(id: string): Promise<void> {
    const s = await this.get(id);
    if (!s) return;
    const trashed = s.videoPath ? await this.trashVideo(s.videoPath) : null;
    await this.restoreOnError(trashed, s.videoPath, () => this.p.db.run('DELETE FROM sessions WHERE id = ?', [id]));
    if (trashed) await this.p.files.remove(trashed);
  }

  /** Moves a video into the trash; null when it is already gone (another call took it). */
  private async trashVideo(videoPath: string): Promise<string | null> {
    const { files } = this.p;
    const from = toDocumentUri(files, videoPath);
    if (!(await files.info(from)).exists) return null;
    const dir = trashDirUri(files);
    await files.ensureDir(dir);
    const to = `${dir}${this.p.newId()}${TRASH_SEPARATOR}${videoPath.slice(videoPath.lastIndexOf('/') + 1)}`;
    try {
      await files.move(from, to);
      return to;
    } catch (err) {
      if ((await files.info(from)).exists) throw err;
      return null;
    }
  }

  /** If the row change fails, the video goes back where its row still points. */
  private async restoreOnError<T>(trashed: string | null, videoPath: string | null, change: () => Promise<T>): Promise<T> {
    try {
      return await change();
    } catch (err) {
      if (trashed && videoPath) {
        await this.p.files.move(trashed, toDocumentUri(this.p.files, videoPath)).catch(() => undefined);
      }
      throw err;
    }
  }
}
