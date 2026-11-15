/**
 * ClipRepo on Supabase Postgres (table shot_clips, migration 0001) through
 * supabase-js with the service-role key. The service role bypasses RLS, so
 * every query here filters on user_id itself.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AnalysisStatus, ClipRepo, ClipRow, Outcome } from '../deps.js';

const TABLE = 'shot_clips';

interface DbRow {
  user_id: string;
  session_id: string;
  shot_number: number;
  shot_type: string;
  release_ms: number;
  outcome: Outcome;
  clip_pathname: string | null;
  start_ms: number;
  end_ms: number;
  size_bytes: number;
  analysis_status: AnalysisStatus;
  analysis: unknown;
  media_deleted_at: string | null;
  shooting_hand: 'right' | 'left' | null;
  created_at: string;
  updated_at: string;
}

const fromDb = (r: DbRow): ClipRow => ({
  userId: r.user_id,
  sessionId: r.session_id,
  shotNumber: Number(r.shot_number),
  shotType: r.shot_type,
  releaseMs: Number(r.release_ms),
  outcome: r.outcome,
  clipPathname: r.clip_pathname,
  startMs: Number(r.start_ms),
  endMs: Number(r.end_ms),
  sizeBytes: Number(r.size_bytes),
  analysisStatus: r.analysis_status,
  analysis: r.analysis,
  mediaDeletedAt: r.media_deleted_at ?? null,
  shootingHand: r.shooting_hand ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new Error(`shot_clips: ${res.error.message}${res.error.code ? ` (${res.error.code})` : ''}`);
  return res.data;
}

export function createSupabaseClient(url: string, serviceRoleKey: string, fetchImpl?: typeof fetch): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

export function createSupabaseClipRepo(db: SupabaseClient): ClipRepo {
  return {
    async upsert(c) {
      check(
        await db.from(TABLE).upsert(
          {
            user_id: c.userId,
            session_id: c.sessionId,
            shot_number: c.shotNumber,
            shot_type: c.shotType,
            release_ms: c.releaseMs,
            outcome: c.outcome,
            clip_pathname: c.clipPathname,
            start_ms: c.startMs,
            end_ms: c.endMs,
            size_bytes: c.sizeBytes,
            // A fresh cut invalidates any earlier analysis of this shot.
            analysis_status: 'pending',
            analysis: null,
            media_deleted_at: null,
            // Only sent when declared, so an upsert never clears a hand set earlier.
            ...(c.shootingHand ? { shooting_hand: c.shootingHand } : {}),
          },
          { onConflict: 'user_id,session_id,shot_number' },
        ),
      );
    },

    async patchOutcome(userId, sessionId, shotNumber, outcome) {
      const rows = check(
        await db
          .from(TABLE)
          .update({ outcome })
          .eq('user_id', userId)
          .eq('session_id', sessionId)
          .eq('shot_number', shotNumber)
          .select('shot_number'),
      );
      return (rows ?? []).length > 0;
    },

    async deleteOne(userId, sessionId, shotNumber) {
      check(await db.from(TABLE).delete().eq('user_id', userId).eq('session_id', sessionId).eq('shot_number', shotNumber));
    },

    async deleteSession(userId, sessionId) {
      check(await db.from(TABLE).delete().eq('user_id', userId).eq('session_id', sessionId));
    },

    async get(userId, sessionId, shotNumber) {
      const rows = check(await db.from(TABLE).select('*').eq('user_id', userId).eq('session_id', sessionId).eq('shot_number', shotNumber).limit(1));
      const r = ((rows ?? []) as DbRow[])[0];
      return r ? fromDb(r) : null;
    },

    async setAnalysis(userId, sessionId, shotNumber, status, analysis, expected) {
      let update = db
        .from(TABLE)
        .update({ analysis_status: status, analysis })
        .eq('user_id', userId)
        .eq('session_id', sessionId)
        .eq('shot_number', shotNumber);
      if (expected) update = update.eq('analysis_status', expected);
      const rows = check(
        await update.select('shot_number'),
      );
      return (rows ?? []).length > 0;
    },

    async setShootingHand(userId, sessionId, hand) {
      check(await db.from(TABLE).update({ shooting_hand: hand }).eq('user_id', userId).eq('session_id', sessionId));
    },

    async markMediaDeleted(userId, sessionId, shotNumber) {
      check(
        await db
          .from(TABLE)
          .update({ clip_pathname: null, media_deleted_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('session_id', sessionId)
          .eq('shot_number', shotNumber)
          .is('media_deleted_at', null),
      );
    },

    async list(userId, sessionId) {
      let q = db.from(TABLE).select('*').eq('user_id', userId);
      if (sessionId) q = q.eq('session_id', sessionId);
      const rows = check(await q.order('session_id').order('shot_number'));
      return ((rows ?? []) as DbRow[]).map(fromDb);
    },

    async listPending(cutoff, limit) {
      const rows = check(await db.from(TABLE).select('*').eq('analysis_status', 'pending')
        .not('clip_pathname', 'is', null).gt('created_at', cutoff).order('created_at')
        .order('user_id').order('session_id').order('shot_number').limit(limit));
      return ((rows ?? []) as DbRow[]).map(fromDb);
    },
  };
}
