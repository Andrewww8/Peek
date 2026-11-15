/**
 * Production coach dependencies: Anthropic model, Postgres checkpointer on the
 * Supabase pooled URL, and the coach_usage / reference tables (migrations 0002, 0003).
 */
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointListOptions } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { anthropicModelFactory } from '../coach/agent.js';
import { COACH_DAILY_LIMIT, COACH_MODEL, COACH_RECURSION_LIMIT, type CoachDeps, type CoachUsageRepo, type ReferenceClipRow, type ReferenceRepo, type ReferenceShotRow, type TemplateRow } from '../coach/deps.js';

/**
 * PostgresSaver that runs `setup()` (creating its own tables) once, on first use.
 * A small pool: on serverless each instance keeps at most 2 connections to the pooler.
 */
export class LazyPostgresSaver extends PostgresSaver {
  private ready: Promise<void> | null = null;
  private ensure() {
    this.ready ??= this.setup().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }
  override async getTuple(config: RunnableConfig) {
    await this.ensure();
    return super.getTuple(config);
  }
  override async *list(config: RunnableConfig, options?: CheckpointListOptions) {
    await this.ensure();
    yield* super.list(config, options);
  }
  override async put(...args: Parameters<PostgresSaver['put']>) {
    await this.ensure();
    return super.put(...args);
  }
  override async putWrites(...args: Parameters<PostgresSaver['putWrites']>) {
    await this.ensure();
    return super.putWrites(...args);
  }
  override async deleteThread(threadId: string) {
    await this.ensure();
    return super.deleteThread(threadId);
  }
}

export function createPostgresCheckpointer(url: string): LazyPostgresSaver {
  // Supabase's pooler presents a certificate node-postgres does not chain to a public root,
  // so `sslmode` in the URL is replaced by TLS without certificate verification.
  const u = new URL(url);
  const wantsSsl = u.searchParams.has('sslmode') || /supabase/.test(u.hostname);
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'supa', 'pgbouncer']) u.searchParams.delete(k);
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2, idleTimeoutMillis: 10_000, ...(wantsSsl ? { ssl: { rejectUnauthorized: false } } : {}) });
  return new LazyPostgresSaver(pool);
}

function check<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}${res.error.code ? ` (${res.error.code})` : ''}`);
  return res.data;
}

export function createSupabaseUsageRepo(db: SupabaseClient): CoachUsageRepo {
  return {
    async consume(userId, day, limit) {
      const rows = check(await db.rpc('coach_consume', { p_user: userId, p_day: day, p_limit: limit }), 'coach_consume') as { allowed: boolean; messages: number }[];
      const r = rows?.[0];
      return { allowed: !!r?.allowed, count: Number(r?.messages ?? 0) };
    },
    async record(userId, day, u) {
      check(
        await db.rpc('coach_record_usage', {
          p_user: userId,
          p_day: day,
          p_input: u.inputTokens,
          p_output: u.outputTokens,
          p_cache_read: u.cacheReadTokens,
          p_cache_creation: u.cacheCreationTokens,
        }),
        'coach_record_usage',
      );
    },
  };
}

interface ClipDb {
  id: string;
  title: string;
  source: string;
  rights_note: string;
  video_pathname: string | null;
  npz_pathname: string | null;
  fps: number;
  created_at: string;
}
interface ShotDb {
  id: string;
  clip_id: string;
  track: number;
  release_frame: number;
  shot_type: string;
  verified: boolean;
  metrics: unknown;
  created_at: string;
}
const clipFromDb = (r: ClipDb): ReferenceClipRow => ({
  id: r.id, title: r.title, source: r.source, rightsNote: r.rights_note, videoPathname: r.video_pathname, npzPathname: r.npz_pathname, fps: Number(r.fps), createdAt: r.created_at,
});
const shotFromDb = (r: ShotDb): ReferenceShotRow => ({
  id: r.id, clipId: r.clip_id, track: Number(r.track), releaseFrame: Number(r.release_frame), shotType: r.shot_type, verified: r.verified, metrics: r.metrics, createdAt: r.created_at,
});

interface TemplateDb {
  player: string;
  shot_type: string;
  shooting_hand: 'right' | 'left';
  fps: number;
  release_index: number;
  shots_averaged: number;
  shots_confident_distance: number;
  metrics: TemplateRow['metrics'];
  curves: TemplateRow['curves'];
  template: TemplateRow['template'];
  source_file: string;
  low_confidence: boolean;
  uncertain_distance: boolean;
  created_at: string;
  updated_at: string;
}
const templateFromDb = (r: TemplateDb): TemplateRow => ({
  player: r.player, shotType: r.shot_type, shootingHand: r.shooting_hand, fps: Number(r.fps), releaseIndex: Number(r.release_index),
  shotsAveraged: Number(r.shots_averaged), shotsConfidentDistance: Number(r.shots_confident_distance), metrics: r.metrics, curves: r.curves,
  template: r.template, sourceFile: r.source_file, lowConfidence: r.low_confidence, uncertainDistance: r.uncertain_distance, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function createSupabaseReferenceRepo(db: SupabaseClient): ReferenceRepo {
  return {
    async upsertTemplate(t) {
      check(
        await db.from('reference_templates').upsert(
          {
            player: t.player, shot_type: t.shotType, shooting_hand: t.shootingHand, fps: t.fps, release_index: t.releaseIndex,
            shots_averaged: t.shotsAveraged, shots_confident_distance: t.shotsConfidentDistance, metrics: t.metrics, curves: t.curves,
            template: t.template, source_file: t.sourceFile, low_confidence: t.lowConfidence, uncertain_distance: t.uncertainDistance,
          },
          { onConflict: 'player,shot_type' },
        ),
        'reference_templates',
      );
    },
    async listTemplates(shotType) {
      let q = db.from('reference_templates').select('*');
      if (shotType) q = q.eq('shot_type', shotType);
      return ((check(await q.order('shot_type').order('player'), 'reference_templates') ?? []) as TemplateDb[]).map(templateFromDb);
    },
    async insertClip(c) {
      check(await db.from('reference_clips').insert({ id: c.id, title: c.title, source: c.source, rights_note: c.rightsNote, video_pathname: c.videoPathname, npz_pathname: c.npzPathname, fps: c.fps }), 'reference_clips');
    },
    async insertShots(shots) {
      if (!shots.length) return;
      check(
        await db.from('reference_shots').insert(shots.map((s) => ({ id: s.id, clip_id: s.clipId, track: s.track, release_frame: s.releaseFrame, shot_type: s.shotType, verified: s.verified, metrics: s.metrics }))),
        'reference_shots',
      );
    },
    async listClips() {
      return ((check(await db.from('reference_clips').select('*').order('created_at'), 'reference_clips') ?? []) as ClipDb[]).map(clipFromDb);
    },
    async listShots(f = {}) {
      let q = db.from('reference_shots').select('*');
      if (f.clipId !== undefined) q = q.eq('clip_id', f.clipId);
      if (f.verified !== undefined) q = q.eq('verified', f.verified);
      if (f.shotType !== undefined) q = q.eq('shot_type', f.shotType);
      return ((check(await q.order('clip_id').order('release_frame'), 'reference_shots') ?? []) as ShotDb[]).map(shotFromDb);
    },
    async setVerified(ids, verified) {
      if (!ids.length) return 0;
      return ((check(await db.from('reference_shots').update({ verified }).in('id', ids).select('id'), 'reference_shots') ?? []) as unknown[]).length;
    },
    async deleteShots(ids) {
      if (!ids.length) return 0;
      return ((check(await db.from('reference_shots').delete().in('id', ids).select('id'), 'reference_shots') ?? []) as unknown[]).length;
    },
    async clearMedia(clipId) {
      check(await db.from('reference_clips').update({ video_pathname: null, npz_pathname: null }).eq('id', clipId), 'reference_clips');
    },
  };
}

export function missingCoachEnv(env: NodeJS.ProcessEnv): string[] {
  return [...(env.ANTHROPIC_API_KEY ? [] : ['ANTHROPIC_API_KEY']), ...(env.POSTGRES_URL ? [] : ['POSTGRES_URL'])];
}

export function createProductionCoach(env: NodeJS.ProcessEnv, db: SupabaseClient, references: ReferenceRepo): CoachDeps {
  return {
    createModel: anthropicModelFactory(env.ANTHROPIC_API_KEY!),
    modelName: COACH_MODEL,
    checkpointer: createPostgresCheckpointer(env.POSTGRES_URL!),
    usage: createSupabaseUsageRepo(db),
    references,
    dailyLimit: Number(env.COACH_DAILY_LIMIT) || COACH_DAILY_LIMIT,
    recursionLimit: COACH_RECURSION_LIMIT,
  };
}
