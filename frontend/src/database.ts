import { SHOT_TYPE, shotStats } from './practice.ts';
import type { Session, ShootingHand, Shot, ShotOutcome } from './practice.ts';

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

type CloudShot = Shot & { sessionId: string };
type CloudState = 'pending' | 'synced' | 'dirty' | 'unavailable';
export type CloudSyncIssue = 'missing_recording' | 'unsupported_recording' | 'recording_too_large'
  | 'recording_too_long' | 'recording_unreadable' | 'release_after_end' | 'invalid_shot' | 'cloud_clip_missing';

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

const cloudSchema = `
  ALTER TABLE sessions ADD COLUMN cloud_user_id TEXT;
  ALTER TABLE shots ADD COLUMN cloud_state TEXT CHECK (cloud_state IN ('pending', 'synced', 'dirty', 'unavailable'));
  ALTER TABLE shots ADD COLUMN cloud_outcome TEXT CHECK (cloud_outcome IN ('made', 'missed', 'unmarked'));
  CREATE INDEX shots_cloud_state ON shots (cloud_state, session_id) WHERE cloud_state IS NOT NULL;
`;

const cloudIssueSchema = `
  ALTER TABLE shots ADD COLUMN cloud_issue TEXT CHECK (cloud_issue IN (
    'missing_recording', 'unsupported_recording', 'recording_too_large', 'recording_too_long',
    'recording_unreadable', 'release_after_end', 'invalid_shot', 'cloud_clip_missing'
  ));
`;

const shootingHandSchema = `
  ALTER TABLE sessions ADD COLUMN shooting_hand TEXT CHECK (shooting_hand IN ('left', 'right'));
`;

const discardedRecordingSchema = `
  CREATE TABLE discarded_recordings (id TEXT PRIMARY KEY NOT NULL);
`;

const SCHEMA_VERSION = 5;

export class PracticeStore {
  private db: PracticeDatabase;

  constructor(db: PracticeDatabase) {
    this.db = db;
    db.execSync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
    const version = db.getFirstSync<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
    if (version > SCHEMA_VERSION) {
      throw new Error('This practice history requires a newer version of Peek.');
    }
    if (version < SCHEMA_VERSION) {
      db.execSync('BEGIN IMMEDIATE;');
      try {
        if (version < 1) db.execSync(schema);
        if (version < 2) db.execSync(cloudSchema);
        if (version < 3) db.execSync(cloudIssueSchema);
        if (version < 4) db.execSync(shootingHandSchema);
        db.execSync(discardedRecordingSchema);
        db.execSync(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      } catch (error) {
        db.execSync('ROLLBACK;');
        throw error;
      }
    }
  }

  getSession(id: string) {
    return this.db.getFirstSync<Session>(`SELECT ${sessionColumns} FROM sessions WHERE id = ?`, id);
  }

  getShootingHand(id: string): ShootingHand | null {
    return this.db.getFirstSync<{ shootingHand: ShootingHand | null }>(
      'SELECT shooting_hand AS shootingHand FROM sessions WHERE id = ?', id,
    )?.shootingHand ?? null;
  }

  setShootingHand(id: string, hand: ShootingHand) {
    const { changes } = this.db.runSync('UPDATE sessions SET shooting_hand = ? WHERE id = ?', hand, id);
    if (!changes) throw new Error('This session could not be found.');
  }

  listSessions() {
    return this.db.getAllSync<Session>(
      `SELECT ${sessionColumns} FROM sessions ORDER BY created_at DESC, id DESC`,
    );
  }

  listCoachSessions(userId: string) {
    return this.db.getAllSync<Session>(
      `SELECT ${sessionColumns} FROM sessions WHERE cloud_user_id = ? AND EXISTS (
         SELECT 1 FROM shots WHERE session_id = sessions.id AND cloud_state IN ('pending', 'synced', 'dirty')
       ) ORDER BY created_at DESC, id DESC`, userId,
    );
  }

  prepareAnalysis(id: string, userId: string, shotNumber?: number) {
    this.db.execSync('BEGIN IMMEDIATE;');
    try {
      const session = this.db.getFirstSync<{ owner: string | null; video: string | null }>(
        'SELECT cloud_user_id AS owner, video_path AS video FROM sessions WHERE id = ?', id,
      );
      if (!session || (session.owner && session.owner !== userId)) {
        throw new Error('This session belongs to a different account.');
      }
      if (!session.owner) {
        if (!session.video) throw new Error('Choose a session with a video to attach.');
        this.db.runSync('UPDATE sessions SET cloud_user_id = ? WHERE id = ?', userId, id);
      }
      if (session.video) {
        this.db.runSync(
          `UPDATE shots SET cloud_state = 'pending', cloud_outcome = outcome, cloud_issue = NULL
           WHERE session_id = ? AND cloud_state IS NULL AND (? IS NULL OR shot_number = ?)`,
          id, shotNumber ?? null, shotNumber ?? null,
        );
      }
      this.db.execSync('COMMIT;');
    } catch (error) {
      this.db.execSync('ROLLBACK;');
      throw error;
    }
  }

  saveSession(session: Session, cloudUserId: string | null = null) {
    this.db.runSync(
      `INSERT INTO sessions (id, created_at, shot_type, video_path, duration_ms, size_bytes, cloud_user_id)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM discarded_recordings WHERE id = ?)
       ON CONFLICT(id) DO NOTHING`,
      session.id, session.createdAt, session.shotType, session.videoPath,
      session.durationMs, session.sizeBytes, cloudUserId, session.id,
    );
  }

  isRecordingDiscarded(id: string) {
    return !!this.db.getFirstSync('SELECT 1 FROM discarded_recordings WHERE id = ?', id);
  }

  discardSession(id: string) {
    this.db.execSync('BEGIN IMMEDIATE;');
    try {
      this.db.runSync('INSERT INTO discarded_recordings (id) VALUES (?) ON CONFLICT(id) DO NOTHING', id);
      this.db.runSync('DELETE FROM sessions WHERE id = ?', id);
      this.db.execSync('COMMIT;');
    } catch (error) {
      this.db.execSync('ROLLBACK;');
      throw error;
    }
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

  addShot(id: string, releaseMs: number, outcome: ShotOutcome, cloudUserId: string | null = null) {
    if (!Number.isSafeInteger(releaseMs) || releaseMs < 0) {
      throw new Error('Choose a moment inside the clip.');
    }
    const { changes } = this.db.runSync(
      `INSERT INTO shots (session_id, shot_number, release_ms, outcome, cloud_state, cloud_outcome)
       SELECT id, COALESCE((SELECT MAX(shot_number) FROM shots WHERE session_id = sessions.id), 0) + 1, ?, ?,
         CASE WHEN cloud_user_id = ? THEN 'pending' END, CASE WHEN cloud_user_id = ? THEN ? END
       FROM sessions WHERE id = ? AND video_path IS NOT NULL AND ? <= duration_ms`,
      releaseMs, outcome, cloudUserId, cloudUserId, outcome, id, releaseMs,
    );
    if (!changes) throw new Error('Choose a moment inside an available clip.');
  }

  updateShot(id: string, shotNumber: number, outcome: ShotOutcome, cloudUserId: string | null = null) {
    const { changes } = this.db.runSync(
      `UPDATE shots SET outcome = ?,
         cloud_outcome = CASE WHEN sessions.cloud_user_id = ? AND cloud_state IS NOT NULL THEN ? ELSE cloud_outcome END,
         cloud_state = CASE WHEN sessions.cloud_user_id = ? AND cloud_state = 'synced' AND cloud_outcome <> ?
                            THEN 'dirty' ELSE cloud_state END
       FROM sessions WHERE sessions.id = shots.session_id AND shots.session_id = ? AND shot_number = ?`,
      outcome, cloudUserId, outcome, cloudUserId, outcome, id, shotNumber,
    );
    if (!changes) throw new Error('That shot could not be found.');
  }

  pendingCloudSessions(userId: string) {
    return this.db.getAllSync<Session>(
      `SELECT ${sessionColumns} FROM sessions WHERE cloud_user_id = ? AND EXISTS (
         SELECT 1 FROM shots WHERE session_id = sessions.id AND cloud_state = 'pending'
       ) ORDER BY created_at, id`, userId,
    );
  }

  hasCloudWork(userId: string) {
    return !!this.db.getFirstSync(
      `SELECT 1 FROM shots JOIN sessions ON sessions.id = shots.session_id
       WHERE cloud_user_id = ? AND cloud_state IN ('pending', 'dirty') LIMIT 1`, userId,
    );
  }

  sessionCloudShots(userId: string, sessionId: string): { shotNumber: number; state: CloudState; issue?: CloudSyncIssue }[] {
    const rows = this.db.getAllSync<{ shotNumber: number; state: CloudState; issue: CloudSyncIssue | null }>(
      `SELECT shot_number AS shotNumber, cloud_state AS state, cloud_issue AS issue FROM shots
       JOIN sessions ON sessions.id = shots.session_id
       WHERE sessions.cloud_user_id = ? AND session_id = ? AND cloud_state IS NOT NULL
       ORDER BY shot_number`, userId, sessionId,
    );
    return rows.map(({ issue, ...shot }) => issue ? { ...shot, issue } : shot);
  }

  cloudShots(userId: string, state: 'pending' | 'dirty', sessionId?: string) {
    const filter = sessionId ? 'AND session_id = ?' : '';
    return this.db.getAllSync<CloudShot>(
      `SELECT session_id AS sessionId, shot_number AS shotNumber, release_ms AS releaseMs, cloud_outcome AS outcome
       FROM shots JOIN sessions ON sessions.id = shots.session_id
       WHERE sessions.cloud_user_id = ? AND cloud_state = ? ${filter}
       ORDER BY session_id, shot_number`, userId, state, ...(sessionId ? [sessionId] : []),
    );
  }

  finishCloudShot(
    userId: string, shot: CloudShot, previous: 'pending' | 'dirty', result: 'saved' | 'unavailable', issue?: CloudSyncIssue,
  ) {
    const next: CloudState = result === 'saved' ? 'synced' : 'unavailable';
    this.db.runSync(
      `UPDATE shots SET cloud_state = CASE WHEN ? = 'synced' AND cloud_outcome <> ? THEN 'dirty' ELSE ? END,
         cloud_issue = ?
       WHERE session_id = ? AND shot_number = ? AND cloud_state = ?
         AND session_id IN (SELECT id FROM sessions WHERE cloud_user_id = ?)`,
      next, shot.outcome, next, result === 'unavailable' ? issue ?? null : null,
      shot.sessionId, shot.shotNumber, previous, userId,
    );
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
