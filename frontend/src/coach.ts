import type { CoachMessage } from '../../mobile/src/core/apiClient.ts';
import { SseParser } from '../../mobile/src/core/coach.ts';
import { accountFetch } from './api.ts';

export const maxCoachQuestionLength = 2000;
const tooSlow = 'Coach took too long to answer. Reopen this chat in a moment to check for the reply.';

function aborted(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
export type RecentChat = { sessionId: string; title: string; reply: string; updatedAt: number };
type OnDeviceShot = {
  releaseMs: number;
  shootingHand: 'left' | 'right';
  releaseElbowDeg: number | null;
  kneeDipDeg: number | null;
  releaseHeight: number | null;
};

/**
 * The API streams a reply for up to its function's maxDuration (300 s) and sends a keep-alive
 * comment every 15 s while tools or the model run, so wait on silence, not on the whole reply.
 */
export const coachReplyTimeouts = { idleMs: 90_000, totalMs: 300_000 };

export function createSessionCoach(
  baseUrl: string, sessionId: string, token: (refresh: boolean) => Promise<string | null>, fetchApi?: typeof fetch,
  timeouts = coachReplyTimeouts,
) {
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}/coach/messages`;
  const request = (init: RequestInit) => accountFetch(baseUrl, token, fetchApi)(path, init);

  async function check(response: Response) {
    if (response.ok) return;
    const error = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    if (response.status === 503) throw new Error('The coach is unavailable. Try again later.');
    if (error?.error === 'session_not_found') {
      throw new Error('No shot clips have synced for this session yet. Keep the app open and try again.');
    }
    throw new Error(error?.message || `The coach returned HTTP ${response.status}.`);
  }

  return {
    async history(signal: AbortSignal) {
      const response = await request({ signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
      await check(response);
      const { messages } = await response.json() as { messages: CoachMessage[] };
      if (!Array.isArray(messages)) throw new Error('Coach returned an invalid conversation.');
      return messages;
    },
    async ask(message: string, signal: AbortSignal, onStatus: (message: string) => void,
      onToken?: (token: string) => void, onDeviceShot?: OnDeviceShot) {
      const quiet = new AbortController();
      let idle: ReturnType<typeof setTimeout> | undefined;
      const waitForData = () => {
        clearTimeout(idle);
        idle = setTimeout(() => quiet.abort(), timeouts.idleMs);
      };
      waitForData();
      const timeout = AbortSignal.any([quiet.signal, AbortSignal.timeout(timeouts.totalMs)]);
      let reader: ReadableStreamDefaultReader<string> | undefined;
      try {
        const response = await request({
          method: 'POST',
          headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, onDeviceShot }),
          signal: AbortSignal.any([signal, timeout]),
        });
        await check(response);
        reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
      } catch (error) {
        clearTimeout(idle);
        if (timeout.aborted && !signal.aborted) throw new Error(tooSlow);
        throw error;
      }
      if (!reader) {
        clearTimeout(idle);
        throw new Error('The coach did not open a reply stream.');
      }
      const parser = new SseParser();
      // Stop waiting even if the fetch implementation does not end the body when its signal aborts.
      const stopped = aborted(timeout);
      stopped.catch(() => undefined);
      try {
        for (;;) {
          waitForData();
          const { done, value } = await Promise.race([reader.read(), stopped]);
          if (done) break;
          for (const { event, data } of parser.push(value)) {
            const update = JSON.parse(data) as { messageId?: string; text?: string; message?: string };
            if (event === 'token' && update.text) onToken?.(update.text);
            if (event === 'tool_status' && update.message) onStatus(update.message);
            if (event === 'error') throw new Error(update.message || 'The coach could not answer right now.');
            if (event === 'done' && update.text?.trim()) {
              return { id: update.messageId ?? null, role: 'assistant', text: update.text, createdAt: null } satisfies CoachMessage;
            }
          }
        }
        throw new Error('The coach disconnected before answering. Reopen this session to check the conversation.');
      } catch (error) {
        if (timeout.aborted && !signal.aborted) throw new Error(tooSlow);
        throw error;
      } finally {
        clearTimeout(idle);
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
