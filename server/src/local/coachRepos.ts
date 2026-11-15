/** Local stand-ins for the coach_usage table and the reference library tables, optionally persisted to JSON. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { CoachUsageRepo, ReferenceClipRow, ReferenceRepo, ReferenceShotRow, TemplateRow, TurnUsage } from '../coach/deps.js';

function jsonStore<T>(file: string | undefined, empty: T): { data: T; save: () => void } {
  let data = empty;
  if (file) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return {
    data,
    save: () => {
      if (!file) return;
      writeFileSync(`${file}.tmp`, JSON.stringify(data));
      renameSync(`${file}.tmp`, file);
    },
  };
}

export interface UsageRow extends Omit<TurnUsage, 'model'> {
  userId: string;
  day: string;
  messages: number;
  turns: number;
}

export function createLocalUsageRepo(file?: string): CoachUsageRepo & { rows(): UsageRow[] } {
  const store = jsonStore<Record<string, UsageRow>>(file, {});
  const row = (userId: string, day: string) =>
    (store.data[`${userId}|${day}`] ??= { userId, day, messages: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  return {
    rows: () => Object.values(store.data).map((r) => ({ ...r })),
    async consume(userId, day, limit) {
      const r = row(userId, day);
      if (r.messages >= limit) return { allowed: false, count: r.messages };
      r.messages++;
      store.save();
      return { allowed: true, count: r.messages };
    },
    async record(userId, day, u) {
      const r = row(userId, day);
      r.turns++;
      r.inputTokens += u.inputTokens;
      r.outputTokens += u.outputTokens;
      r.cacheReadTokens += u.cacheReadTokens;
      r.cacheCreationTokens += u.cacheCreationTokens;
      store.save();
    },
  };
}

export function createLocalReferenceRepo(file?: string): ReferenceRepo {
  const store = jsonStore<{ clips: ReferenceClipRow[]; shots: ReferenceShotRow[]; templates?: TemplateRow[] }>(file, { clips: [], shots: [], templates: [] });
  const now = () => new Date().toISOString();
  return {
    async upsertTemplate(t) {
      const list = (store.data.templates ??= []);
      const at = now();
      const i = list.findIndex((x) => x.player === t.player && x.shotType === t.shotType);
      const row: TemplateRow = { ...structuredClone(t), createdAt: i >= 0 ? list[i]!.createdAt : at, updatedAt: at };
      if (i >= 0) list[i] = row;
      else list.push(row);
      store.save();
    },
    async listTemplates(shotType) {
      return structuredClone((store.data.templates ?? []).filter((t) => !shotType || t.shotType === shotType).sort((a, b) => (a.shotType + a.player < b.shotType + b.player ? -1 : 1)));
    },
    async insertClip(c) {
      store.data.clips.push({ ...c, createdAt: now() });
      store.save();
    },
    async insertShots(shots) {
      store.data.shots.push(...shots.map((s) => ({ ...structuredClone(s), createdAt: now() })));
      store.save();
    },
    async listClips() {
      return structuredClone(store.data.clips);
    },
    async listShots(f = {}) {
      return structuredClone(
        store.data.shots
          .filter((s) => (f.clipId === undefined || s.clipId === f.clipId) && (f.verified === undefined || s.verified === f.verified) && (f.shotType === undefined || s.shotType === f.shotType))
          .sort((a, b) => (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : a.releaseFrame - b.releaseFrame)),
      );
    },
    async setVerified(ids, verified) {
      let n = 0;
      for (const s of store.data.shots) if (ids.includes(s.id)) (s.verified = verified), n++;
      store.save();
      return n;
    },
    async deleteShots(ids) {
      const before = store.data.shots.length;
      store.data.shots = store.data.shots.filter((s) => !ids.includes(s.id));
      store.save();
      return before - store.data.shots.length;
    },
    async clearMedia(clipId) {
      for (const c of store.data.clips) if (c.id === clipId) (c.videoPathname = null), (c.npzPathname = null);
      store.save();
    },
  };
}
