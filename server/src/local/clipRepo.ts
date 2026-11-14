/**
 * ClipRepo kept in memory and, when given a file, persisted to JSON after each
 * change (written atomically), so `npm run server` keeps clips across restarts.
 * Same key and semantics as the shot_clips table: primary key
 * (user_id, session_id, shot_number), upsert resets analysis to pending,
 * created_at survives an upsert, updated_at changes on every write.
 */
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import type { ClipRepo, ClipRow } from '../deps.js';

export function createLocalClipRepo(file?: string, now: () => Date = () => new Date()): ClipRepo & { rows(): ClipRow[] } {
  const rows = new Map<string, ClipRow>();
  const key = (u: string, s: string, n: number) => `${u}|${s}|${n}`;
  if (file) {
    let saved: ClipRow[] = [];
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const r of saved) rows.set(key(r.userId, r.sessionId, r.shotNumber), r);
  }
  let writing: Promise<void> = Promise.resolve();
  const persist = () => {
    if (!file) return Promise.resolve();
    const snapshot = JSON.stringify([...rows.values()], null, 1);
    writing = writing.then(async () => {
      await writeFile(`${file}.tmp`, snapshot);
      await rename(`${file}.tmp`, file);
    });
    return writing;
  };
  const sorted = (list: ClipRow[]) =>
    list.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.shotNumber - b.shotNumber));

  return {
    rows: () => sorted([...rows.values()].map((r) => ({ ...r }))),

    async upsert(c) {
      const k = key(c.userId, c.sessionId, c.shotNumber);
      const at = now().toISOString();
      rows.set(k, { ...c, analysisStatus: 'pending', analysis: null, createdAt: rows.get(k)?.createdAt ?? at, updatedAt: at });
      await persist();
    },

    async patchOutcome(userId, sessionId, shotNumber, outcome) {
      const r = rows.get(key(userId, sessionId, shotNumber));
      if (!r) return false;
      r.outcome = outcome;
      r.updatedAt = now().toISOString();
      await persist();
      return true;
    },

    async deleteOne(userId, sessionId, shotNumber) {
      if (rows.delete(key(userId, sessionId, shotNumber))) await persist();
    },

    async deleteSession(userId, sessionId) {
      let changed = false;
      for (const [k, r] of rows) {
        if (r.userId === userId && r.sessionId === sessionId) changed = rows.delete(k) || changed;
      }
      if (changed) await persist();
    },

    async list(userId, sessionId) {
      return sorted([...rows.values()].filter((r) => r.userId === userId && (!sessionId || r.sessionId === sessionId)).map((r) => ({ ...r })));
    },
  };
}
