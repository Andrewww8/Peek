import { SHOT_TYPE, shotStats } from './practice.ts';
import type { Session, Shot, ShotOutcome } from './practice.ts';

type SqlValue = string | number | null;

export interface PracticeDatabase {
  execSync(sql: string): void;
  runSync(sql: string, ...args: SqlValue[]): { changes: number | bigint };
  getAllSync<T>(sql: string, ...args: SqlValue[]): T[];
  getFirstSync<T>(sql: string, ...args: SqlValue[]): T | null;
}

export type SavedDemo = {
  id: string;
  version: number;
  format: 'usdz';
  shotType: typeof SHOT_TYPE;
  localPath: string;
  cue: string;
  sizeBytes: number;
};

const schema = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    shot_type TEXT NOT NULL,
    video_path TEXT,
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0)
  );

  CREATE TABLE IF NOT EXISTS shots (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    shot_number INTEGER NOT NULL CHECK (shot_number > 0),
    release_ms INTEGER NOT NULL CHECK (release_ms >= 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('made', 'missed', 'unmarked')),
    PRIMARY KEY (session_id, shot_number)
  );

  CREATE TABLE IF NOT EXISTS downloaded_demos (
    demo_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    format TEXT NOT NULL,
    shot_type TEXT NOT NULL,
    local_path TEXT NOT NULL,
    cue TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    PRIMARY KEY (demo_id, version, format)
  );
`;

const sessionColumns = `id, created_at AS createdAt, shot_type AS shotType,
  video_path AS videoPath, duration_ms AS durationMs, size_bytes AS sizeBytes`;

export class PracticeStore {
  private db: PracticeDatabase;

  constructor(db: PracticeDatabase) {
    this.db = db;
    db.execSync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
    const version = db.getFirstSync<{ user_version: number }>('PRAGMA user_version')?.user_version;
    if (version === 0) {
      db.execSync('BEGIN IMMEDIATE;');
      try {
        db.execSync(schema);
        db.execSync('PRAGMA user_version = 1; COMMIT;');
      } catch (error) {
        db.execSync('ROLLBACK;');
        throw error;
      }
    } else if (version !== 1) {
      throw new Error('This practice history requires a newer version of Perspective.');
    }
  }

  getSession(id: string) {
    return this.db.getFirstSync<Session>(`SELECT ${sessionColumns} FROM sessions WHERE id = ?`, id);
  }

  listSessions() {
    return this.db.getAllSync<Session>(
      `SELECT ${sessionColumns} FROM sessions ORDER BY created_at DESC, id DESC`,
    );
  }

  saveSession(session: Session) {
    this.db.runSync(
      `INSERT INTO sessions (id, created_at, shot_type, video_path, duration_ms, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      session.id, session.createdAt, session.shotType, session.videoPath,
      session.durationMs, session.sizeBytes,
    );
  }

  clearVideo(id: string) {
    this.db.runSync('UPDATE sessions SET video_path = NULL WHERE id = ?', id);
  }

  listShots(id: string) {
    return this.db.getAllSync<Shot>(
      `SELECT shot_number AS shotNumber, release_ms AS releaseMs, outcome FROM shots
       WHERE session_id = ? ORDER BY release_ms, shot_number`, id,
    );
  }

  addShot(id: string, releaseMs: number, outcome: ShotOutcome) {
    if (!Number.isSafeInteger(releaseMs) || releaseMs < 0) {
      throw new Error('Choose a moment inside the clip.');
    }
    const { changes } = this.db.runSync(
      `INSERT INTO shots (session_id, shot_number, release_ms, outcome)
       SELECT id, COALESCE((SELECT MAX(shot_number) FROM shots WHERE session_id = sessions.id), 0) + 1, ?, ?
       FROM sessions WHERE id = ? AND video_path IS NOT NULL AND ? <= duration_ms`,
      releaseMs, outcome, id, releaseMs,
    );
    if (!changes) throw new Error('Choose a moment inside an available clip.');
  }

  updateShot(id: string, shotNumber: number, outcome: ShotOutcome) {
    const { changes } = this.db.runSync(
      'UPDATE shots SET outcome = ? WHERE session_id = ? AND shot_number = ?',
      outcome, id, shotNumber,
    );
    if (!changes) throw new Error('That shot could not be found.');
  }

  listSessionSummaries() {
    return this.listSessions().map((session) => ({
      ...session,
      stats: shotStats(this.listShots(session.id)),
    }));
  }

  listDemos() {
    return this.db.getAllSync<SavedDemo>(
      `SELECT demo_id AS id, version, format, shot_type AS shotType,
       local_path AS localPath, cue, size_bytes AS sizeBytes FROM downloaded_demos
       WHERE shot_type = ? AND format = 'usdz' ORDER BY version DESC, demo_id`,
      SHOT_TYPE,
    );
  }

  saveDemo(demo: SavedDemo) {
    this.db.runSync(
      `INSERT INTO downloaded_demos (demo_id, version, format, shot_type, local_path, cue, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(demo_id, version, format) DO UPDATE SET
         local_path = excluded.local_path, cue = excluded.cue, size_bytes = excluded.size_bytes`,
      demo.id, demo.version, demo.format, demo.shotType, demo.localPath, demo.cue, demo.sizeBytes,
    );
  }
}
