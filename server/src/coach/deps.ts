/** Dependencies of the AI coach and the pro reference library. */
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { TemplateRecord } from '../cv/templates.js';

export const COACH_MODEL = 'claude-sonnet-5-5';
export const COACH_DAILY_LIMIT = 50;
export const GUEST_DAILY_LIMIT = 5;
export const GUEST_LIMIT_MESSAGE = `You’ve reached today’s guest limit of ${GUEST_DAILY_LIMIT} shot analyses or Coach messages. Try again after midnight UTC.`;
export const COACH_RECURSION_LIMIT = 40;
export const COACH_MAX_MESSAGE_CHARS = 2000;

export type GuestDailyLimit = typeof GUEST_DAILY_LIMIT | null;

export function guestDailyLimitFromEnv(value: string | undefined): GuestDailyLimit {
  const configured = value?.trim();
  if (!configured || configured === 'unlimited') return null;
  if (configured === String(GUEST_DAILY_LIMIT)) return GUEST_DAILY_LIMIT;
  throw new Error(`PEEK_GUEST_DAILY_LIMIT must be ${GUEST_DAILY_LIMIT} or unlimited`);
}

export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface CoachUsageRepo {
  count(userId: string, day: string): Promise<number>;
  /** Atomically counts one request for (user, day). A null limit allows unlimited requests. */
  consume(userId: string, day: string, limit: number | null): Promise<{ allowed: boolean; count: number }>;
  /** Adds one turn's token usage to (user, day). */
  record(userId: string, day: string, usage: TurnUsage): Promise<void>;
}

export interface ReferenceClipRow {
  id: string;
  title: string;
  source: string;
  rightsNote: string;
  videoPathname: string | null;
  npzPathname: string | null;
  fps: number;
  createdAt: string;
}

export interface ReferenceShotRow {
  id: string;
  clipId: string;
  track: number;
  releaseFrame: number;
  shotType: string;
  verified: boolean;
  /** The shot's analysis: metrics, quality and compact pose (same shape as shot_clips.analysis). */
  metrics: unknown;
  createdAt: string;
}

/** One averaged pro shot template (reference_templates, migration 0004). */
export interface TemplateRow extends TemplateRecord {
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceRepo {
  /** Insert or update by (player, shotType): re-running the ingest never duplicates. */
  upsertTemplate(t: TemplateRecord): Promise<void>;
  listTemplates(shotType?: string): Promise<TemplateRow[]>;
  insertClip(c: Omit<ReferenceClipRow, 'createdAt'>): Promise<void>;
  insertShots(shots: Omit<ReferenceShotRow, 'createdAt'>[]): Promise<void>;
  listClips(): Promise<ReferenceClipRow[]>;
  listShots(filter?: { clipId?: string; verified?: boolean; shotType?: string }): Promise<ReferenceShotRow[]>;
  /** Number of rows changed. */
  setVerified(ids: string[], verified: boolean): Promise<number>;
  deleteShots(ids: string[]): Promise<number>;
  /** After review: the clip's source video and npz are gone. */
  clearMedia(clipId: string): Promise<void>;
}

/** Which model a call is for: the conversational coach, or the form-analyst subagent. */
export type ModelRole = 'coach' | 'analyst';

export interface CoachDeps {
  /**
   * Loads what `createModel` and `checkpointer` need (LangChain, the Anthropic SDK, the
   * checkpointer), so that a cold start serving other routes skips them. The coach routes
   * await it before using either.
   */
  prepare?: () => Promise<void>;
  createModel: (role: ModelRole) => BaseChatModel;
  modelName: string;
  checkpointer: BaseCheckpointSaver;
  usage: CoachUsageRepo;
  references: ReferenceRepo;
  dailyLimit: number;
  recursionLimit: number;
  /** Today's date as YYYY-MM-DD (UTC); injectable for tests. */
  today?: () => string;
  /** SSE keep-alive interval; the phone allows 90 s idle. */
  keepAliveMs?: number;
}
