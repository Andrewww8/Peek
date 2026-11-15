/**
 * The coach: a Deep Agent on Claude Sonnet 5.5.
 *
 * Model settings, checked against @langchain/anthropic 1.6.5 (dist/chat_models.js):
 * - `outputConfig: { effort: 'medium' }` is sent as `output_config`.
 * - Thinking is left unset: `thinking` is only sent when explicitly configured,
 *   so the model's default (adaptive) applies.
 * - Refusal fallbacks: `betas: ['server-side-fallback-2026-07-01']` switches the
 *   call to `client.beta.messages.create`, and `invocationKwargs: { fallbacks: 'default' }`
 *   is spread into that request body.
 * - Prompt caching: deepagents adds `anthropicPromptCachingMiddleware` and a
 *   cache-breakpoint middleware for Anthropic models, which mark the system prompt,
 *   tools and conversation prefix with `cache_control`.
 * - No forced tool_choice anywhere, and no toolStrategy: Sonnet 5.5 rejects forced
 *   tool use. The form-analyst subagent's structured output uses providerStrategy
 *   (native JSON-schema output).
 */
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createDeepAgent, StateBackend } from 'deepagents';
import { AIMessage } from '@langchain/core/messages';
import { createMiddleware, providerStrategy } from 'langchain';
import { z } from 'zod';
import type { ClipRepo } from '../deps.js';
import { COACH_MODEL, type CoachDeps, type ModelRole } from './deps.js';
import { MIDRANGE_FORM_SKILL, THREE_POINT_FORM_SKILL, skillPath } from './skill.js';
import { coachContextSchema, createCoachTools } from './tools.js';

export const COACH_SYSTEM_PROMPT = `You are Perspective's basketball shooting coach. Answer general shooting questions and help the player with their practice session when they share one.

How you work:
- Every number you mention must come from a tool result in this conversation. Never estimate, invent, or round a number into something the tools did not return.
- Start from get_session_overview when you need context. Refer to shots by number ("shot 3") and name the metric behind each piece of feedback.
- Read the form skill for the session's shot type (three-point-form or midrange-form) before giving form feedback, and use its cues, drills and pro ranges.
- Give specific, encouraging, actionable feedback: one to three priorities, each with a cue or a drill.
- If there are no shot measurements or tags, give general shooting guidance. A player can start a chat without a clip.
- If shots have tags and analysis is pending, coach from the available tags and stats and explain that form analysis is pending.
- A session overview may include an onDeviceShot. Treat that as the iPhone's estimate for one clip, without an outcome, a shot number, or server confidence flags. Its release height is relative to the head in body heights. Use it as limited form context and do not infer missing measurements or outcomes.
- If a shot's quality flags say the measurement is unreliable, say so and do not lean on it.

Comparing with professionals (compare_to_reference, find_similar_pros, list_pro_references, get_pro_profile):
- For a named pro, call compare_to_reference with that pro's name. Omit the shot number for an iPhone-only estimate and describe the result as an estimate. If no personal comparison is possible, use get_pro_profile for that pro and say what shot analysis is needed.
- Pro numbers are data-derived averages of many shots per player, from video. Say so, and mention the reliability flags the tools return (few shots averaged, uncertain shot distance).
- Pros differ in style. Frame the target as the pro range and the player's closest-matching pros, never as "copy this one pro".
- Never claim a pro does something wrong or badly; describe how the player differs from them. Naming the pros is fine.
- If the tools say a comparison is unavailable, say so plainly and coach from the curated knowledge instead.
- If a tool returns handUncertain or a handNote, ask the player which hand they shoot with before leaning on pro comparisons (the app lets them set it), and say the comparison may change.

- For "analyze my whole session" questions with synced shots, delegate to the form-analyst subagent with the task tool.
- No medical or injury diagnosis: if the player mentions pain or injury, suggest they see a qualified professional.
- Stay on basketball and this player's shooting. Politely decline anything else.
- Keep answers short enough to read on a phone.`;

const ANALYST_PROMPT = `You analyze one player's practice session of three-point shots using the metric tools.
Call get_session_overview, compare_made_vs_missed, and get_shot_metrics for the most informative shots.
Use only numbers the tools return. Return the strongest findings, each tied to a metric and shot numbers.`;

export const analystFindings = z.object({
  findings: z.array(
    z.object({
      metric: z.string(),
      observation: z.string(),
      shotNumbers: z.array(z.number()),
    }),
  ),
  dataQualityNotes: z.array(z.string()),
});

export const ANTHROPIC_BETAS = ['server-side-fallback-2026-07-01'] as const;

/** Production model factory. */
export function anthropicModelFactory(apiKey: string, extra: Partial<ConstructorParameters<typeof ChatAnthropic>[0]> = {}) {
  return (role: ModelRole): BaseChatModel =>
    new ChatAnthropic({
      model: COACH_MODEL,
      apiKey,
      maxTokens: role === 'coach' ? 16_000 : 8_000,
      outputConfig: { effort: 'medium' },
      betas: [...ANTHROPIC_BETAS],
      invocationKwargs: { fallbacks: 'default' },
      streaming: role === 'coach',
      ...extra,
    });
}

/** The skill file for the agent's in-memory filesystem (StateBackend). */
export function skillFiles(now = new Date().toISOString()) {
  const file = (content: string) => ({ content, mimeType: 'text/markdown', created_at: now, modified_at: now });
  return { [skillPath('three_point')]: file(THREE_POINT_FORM_SKILL), [skillPath('midrange')]: file(MIDRANGE_FORM_SKILL) };
}

/** Stamps each model reply with its creation time, for the chat history the phone shows. */
export const stampCreatedAt = createMiddleware({
  name: 'StampCreatedAt',
  wrapModelCall: async (request, handler) => {
    const res = await handler(request);
    if (AIMessage.isInstance(res)) res.additional_kwargs = { ...res.additional_kwargs, createdAt: new Date().toISOString() };
    return res;
  },
});

export function createCoachAgent(coach: CoachDeps, clips: ClipRepo) {
  const tools = createCoachTools({ clips, references: coach.references });
  return createDeepAgent({
    name: 'perspective-coach',
    model: coach.createModel('coach'),
    tools,
    systemPrompt: COACH_SYSTEM_PROMPT,
    contextSchema: coachContextSchema,
    checkpointer: coach.checkpointer,
    backend: (config) => new StateBackend(config as ConstructorParameters<typeof StateBackend>[0]),
    skills: ['/skills/'],
    middleware: [stampCreatedAt],
    subagents: [
      {
        name: 'form-analyst',
        description: "Runs the metric tools over the player's whole session and returns structured findings. Use it for 'analyze my whole session' questions.",
        systemPrompt: ANALYST_PROMPT,
        tools,
        model: coach.createModel('analyst'),
        responseFormat: providerStrategy(analystFindings),
      },
    ],
  });
}
export type CoachAgent = ReturnType<typeof createCoachAgent>;
