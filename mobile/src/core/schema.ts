import type { SqlDatabase } from './ports';

/** Ordered migrations; index + 1 is the resulting PRAGMA user_version. Append only. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY NOT NULL,
    created_at  INTEGER NOT NULL,
    shot_type   TEXT NOT NULL,
    video_path  TEXT,
    duration_ms INTEGER,
    size_bytes  INTEGER
  );
  CREATE INDEX sessions_created_at ON sessions (created_at DESC);

  CREATE TABLE shots (
    session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    shot_number INTEGER NOT NULL,
    release_ms  INTEGER NOT NULL,
    outcome     TEXT NOT NULL DEFAULT 'unmarked' CHECK (outcome IN ('made', 'missed', 'unmarked')),
    PRIMARY KEY (session_id, shot_number)
  );

  CREATE TABLE downloaded_demos (
    demo_id       TEXT NOT NULL,
    version       INTEGER NOT NULL,
    format        TEXT NOT NULL,
    shot_type     TEXT NOT NULL,
    local_path    TEXT NOT NULL,
    cue           TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    downloaded_at INTEGER NOT NULL,
    PRIMARY KEY (demo_id, version, format)
  );
  `,
  // v2: shot numbers are never reused. The counter only moves forward, so a
  // deleted last shot's number is not handed to the next shot (a stale tag
  // edit would otherwise hit the wrong shot). The trigger runs inside the
  // INSERT statement, so numbering stays atomic without a JS transaction.
  `
  ALTER TABLE sessions ADD COLUMN last_shot_number INTEGER NOT NULL DEFAULT 0;
  UPDATE sessions
     SET last_shot_number = COALESCE((SELECT MAX(shot_number) FROM shots WHERE shots.session_id = sessions.id), 0);
  CREATE TRIGGER shots_advance_last_number AFTER INSERT ON shots
  BEGIN
    UPDATE sessions SET last_shot_number = NEW.shot_number
     WHERE id = NEW.session_id AND last_shot_number < NEW.shot_number;
  END;
  `,
  // v3: shot clips upload to the cloud API (see ClipSync). clip_state:
  //   local_only     never uploads: tagged while signed out, or tagged before
  //                  this version (backfill), or pending at a signed-out sync
  //   pending        waiting for its session's recording to upload
  //   cutting        a POST …/clips that includes it was sent; the server may
  //                  hold its clip. Retried like pending (the POST is idempotent)
  //   synced         the server holds its clip with this outcome
  //   outcome_dirty  synced, but the outcome changed since: needs a PATCH
  //   unavailable    nothing to cut (video removed first), or the server lost it
  // Triggers queue the remote DELETEs in the same statement as the local
  // delete, only when the server may hold something (cutting/synced/dirty):
  // one row per shot, or shot_number 0 for a whole session. A cascade from a
  // session delete is covered by the session row, so the shot trigger skips it.
  `
  ALTER TABLE shots ADD COLUMN clip_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (clip_state IN ('local_only', 'pending', 'cutting', 'synced', 'outcome_dirty', 'unavailable'));
  UPDATE shots SET clip_state = 'local_only';
  CREATE INDEX shots_clip_state ON shots (clip_state, session_id);

  CREATE TABLE clip_deletes (
    session_id  TEXT NOT NULL,
    shot_number INTEGER NOT NULL,
    PRIMARY KEY (session_id, shot_number)
  );

  CREATE TRIGGER shots_queue_clip_delete AFTER DELETE ON shots
  WHEN OLD.clip_state IN ('cutting', 'synced', 'outcome_dirty')
   AND EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
  BEGIN
    INSERT OR IGNORE INTO clip_deletes (session_id, shot_number) VALUES (OLD.session_id, OLD.shot_number);
  END;

  CREATE TRIGGER sessions_queue_clip_delete BEFORE DELETE ON sessions
  WHEN EXISTS (SELECT 1 FROM shots WHERE session_id = OLD.id AND clip_state IN ('cutting', 'synced', 'outcome_dirty'))
  BEGIN
    INSERT OR IGNORE INTO clip_deletes (session_id, shot_number) VALUES (OLD.id, 0);
  END;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Runs once per launch, before createPerspectiveBackend hands out any store,
 * so nothing else can issue a query on the connection while a migration's
 * transaction is open. That is why this one use of the (unserialized)
 * transaction port is safe. A kill mid-migration rolls back the DDL and the
 * user_version bump together. The Expo entry point (startBackend) is
 * idempotent, so two overlapping launches cannot share the cached connection.
 */
export async function initDatabase(db: SqlDatabase): Promise<void> {
  await db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const row = await db.first<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(`Database schema v${current} is newer than this app (v${SCHEMA_VERSION}).`);
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    await db.transaction(async () => {
      await db.exec(MIGRATIONS[v]!);
      await db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
