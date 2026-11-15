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
    for (const r of saved) rows.set(key(r.userId, r.sessionId, r.shotNumber), { ...r, mediaDeletedAt: r.mediaDeletedAt ?? null, shootingHand: r.shootingHand ?? null });
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
    rows: () => sorted([...rows.values()].map((r) => structuredClone(r))),

    async upsert(c) {
      const k = key(c.userId, c.sessionId, c.shotNumber);
      const at = now().toISOString();
      const prev = rows.get(k);
      rows.set(k, { ...c, shootingHand: c.shootingHand ?? prev?.shootingHand ?? null, analysisStatus: 'pending', analysis: null, mediaDeletedAt: null, createdAt: prev?.createdAt ?? at, updatedAt: at });
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

    async get(userId, sessionId, shotNumber) {
      const r = rows.get(key(userId, sessionId, shotNumber));
      return r ? structuredClone(r) : null;
    },

    async setAnalysis(userId, sessionId, shotNumber, status, analysis, expected) {
      const r = rows.get(key(userId, sessionId, shotNumber));
      if (!r || (expected && r.analysisStatus !== expected)) return false;
      // One assignment, like the single UPDATE in production.
      rows.set(key(userId, sessionId, shotNumber), { ...r, analysisStatus: status, analysis: structuredClone(analysis), updatedAt: now().toISOString() });
      await persist();
      return true;
    },

    async setShootingHand(userId, sessionId, hand) {
      let changed = false;
      for (const r of rows.values()) {
        if (r.userId === userId && r.sessionId === sessionId && r.shootingHand !== hand) {
          r.shootingHand = hand;
          r.updatedAt = now().toISOString();
          changed = true;
        }
      }
      if (changed) await persist();
    },

    async markMediaDeleted(userId, sessionId, shotNumber) {
      const r = rows.get(key(userId, sessionId, shotNumber));
      if (!r) return;
      r.clipPathname = null;
      r.mediaDeletedAt ??= now().toISOString();
      r.updatedAt = now().toISOString();
      await persist();
    },

    async list(userId, sessionId) {
      return sorted([...rows.values()].filter((r) => r.userId === userId && (!sessionId || r.sessionId === sessionId)).map((r) => structuredClone(r)));
    },

    async listPending(cutoff, limit) {
      return [...rows.values()]
        .filter((r) => r.analysisStatus === 'pending' && r.clipPathname && r.createdAt > cutoff)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        .map((r) => structuredClone(r));
    },
  };
}
