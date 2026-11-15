/**
 * Coach chat endpoints (PROJECT_CONTEXT.md, "AI coach"), registered inside the
 * authenticated clip-API scope.
 *
 * SSE wire format (matches mobile/src/core/coach.ts):
 *   event: token        data: {"text":"..."}
 *   event: tool_status  data: {"tool":"shot_metrics","message":"Looking at shot 3…"}
 *   event: done         data: {"messageId":"...","text":"<full reply>"}
 *   event: error        data: {"code":"...","message":"..."}
 * plus `: ping` comments every ~15 s while tools or the model run.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AIMessage, HumanMessage, isAIMessage, isHumanMessage, type BaseMessage } from '@langchain/core/messages';
import { ApiError } from '../clips.js';
import type { ClipRepo } from '../deps.js';
import { createCoachAgent, skillFiles, type CoachAgent } from './agent.js';
import { COACH_MAX_MESSAGE_CHARS, type CoachDeps, type TurnUsage } from './deps.js';
import { toolStatus } from './tools.js';

const threadId = (userId: string, sessionId: string) => `${userId}:${sessionId}`;
const utcDay = () => new Date().toISOString().slice(0, 10);

/** Plain text of a message or chunk: text blocks only (thinking and tool calls are never shown). */
export function textOf(m: { content: unknown }): string {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (b && typeof b === 'object' && (b.type === 'text' || b.type === 'text_delta') && typeof b.text === 'string' ? b.text : '')).join('');
}

const createdAtOf = (m: BaseMessage) => {
  const v = (m.additional_kwargs as Record<string, unknown> | undefined)?.createdAt;
  return typeof v === 'string' ? v : null;
};

export function coachRoutes(app: FastifyInstance, opts: { coach?: CoachDeps; clips: ClipRepo; sessionParam: (v: unknown) => string }) {
  const { coach, clips, sessionParam } = opts;
  let agent: CoachAgent | null = null;
  const getAgent = () => (agent ??= createCoachAgent(coach!, clips));
  const need = () => {
    if (!coach) throw new ApiError(503, 'not_configured', 'the AI coach is not configured');
    return coach;
  };

  app.post<{ Params: { sessionId: string } }>('/v1/sessions/:sessionId/coach/messages', async (req, reply) => {
    const c = need();
    const sessionId = sessionParam(req.params.sessionId);
    const body = req.body as { message?: unknown } | null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > COACH_MAX_MESSAGE_CHARS) {
      throw new ApiError(400, 'invalid_request', `message must be 1 to ${COACH_MAX_MESSAGE_CHARS} characters`);
    }
    const userId = req.userId;
    if (!(await clips.list(userId, sessionId)).length) throw new ApiError(404, 'session_not_found', 'no synced clips for this session');
    const day = (c.today ?? utcDay)();
    const quota = await c.usage.consume(userId, day, c.dailyLimit);
    if (!quota.allowed) throw new ApiError(429, 'coach_daily_limit', `the coach answers up to ${c.dailyLimit} messages a day`);

    const config = { configurable: { thread_id: threadId(userId, sessionId) }, context: { userId, sessionId } };
    const a = getAgent();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), c.keepAliveMs ?? 15_000);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const usage: TurnUsage = { model: c.modelName, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const countUsage = {
      handleLLMEnd(output: { generations?: { message?: { usage_metadata?: any } }[][] }) {
        for (const g of output.generations?.flat() ?? []) {
          const u = g.message?.usage_metadata;
          if (!u) continue;
          usage.inputTokens += u.input_tokens ?? 0;
          usage.outputTokens += u.output_tokens ?? 0;
          usage.cacheReadTokens += u.input_token_details?.cache_read ?? 0;
          usage.cacheCreationTokens += u.input_token_details?.cache_creation ?? 0;
        }
      },
    };

    let text = '';
    try {
      const stream = await a.stream(
        { messages: [new HumanMessage({ id: randomUUID(), content: message, additional_kwargs: { createdAt: new Date().toISOString() } })], files: skillFiles() } as never,
        { ...config, streamMode: ['messages', 'updates'], recursionLimit: c.recursionLimit, signal: abort.signal, callbacks: [countUsage] } as never,
      );
      for await (const event of stream as AsyncIterable<[string, any]>) {
        const [mode, payload] = event;
        if (mode === 'messages') {
          const [chunk, meta] = payload as [BaseMessage, Record<string, unknown>];
          if (meta?.langgraph_node !== 'model_request' || !isAIMessage(chunk)) continue;
          const t = textOf(chunk);
          if (t) {
            text += t;
            send('token', { text: t });
          }
        } else if (mode === 'updates') {
          for (const m of (payload?.model_request?.messages ?? []) as BaseMessage[]) {
            if (!isAIMessage(m)) continue;
            for (const call of m.tool_calls ?? []) send('tool_status', toolStatus(call.name, call.args ?? {}));
            // A tool-calling step's text belongs to that step, not the final answer.
            if (m.tool_calls?.length) text = '';
          }
        }
      }
      const state: any = await a.getState(config as any);
      const last = [...((state.values as { messages?: BaseMessage[] }).messages ?? [])].reverse().find((m) => isAIMessage(m) && !m.tool_calls?.length);
      send('done', { messageId: last?.id ?? randomUUID(), text: last ? textOf(last) : text });
    } catch (err) {
      // By name: langchain's agent may run on its own copy of @langchain/langgraph, so instanceof is unreliable.
      const code = (err as Error)?.name === 'GraphRecursionError' ? 'coach_step_limit' : abort.signal.aborted ? 'cancelled' : 'coach_failed';
      req.log.error({ err, userId, sessionId }, 'coach turn failed');
      send('error', { code, message: code === 'coach_step_limit' ? 'The coach took too many steps on this question.' : 'The coach could not answer right now.' });
    } finally {
      clearInterval(ping);
      await c.usage.record(userId, day, usage).catch((err) => req.log.error({ err }, 'could not record coach usage'));
      req.log.info({ coachTurn: { userId, sessionId, day, messagesToday: quota.count, ...usage } }, 'coach turn usage');
      res.end();
    }
  });

  app.get<{ Params: { sessionId: string } }>('/v1/sessions/:sessionId/coach/messages', async (req) => {
    need();
    const sessionId = sessionParam(req.params.sessionId);
    const state: any = await getAgent().getState({ configurable: { thread_id: threadId(req.userId, sessionId) } } as any);
    const messages = ((state?.values as { messages?: BaseMessage[] } | undefined)?.messages ?? [])
      .filter((m) => isHumanMessage(m) || (isAIMessage(m) && !(m as AIMessage).tool_calls?.length && textOf(m)))
      .map((m) => ({ id: m.id ?? null, role: isHumanMessage(m) ? 'user' : 'assistant', text: textOf(m), createdAt: createdAtOf(m) }));
    return { messages };
  });

  app.delete<{ Params: { sessionId: string } }>('/v1/sessions/:sessionId/coach', async (req, reply) => {
    const c = need();
    const sessionId = sessionParam(req.params.sessionId);
    await c.checkpointer.deleteThread(threadId(req.userId, sessionId));
    return reply.code(204).send();
  });
}
