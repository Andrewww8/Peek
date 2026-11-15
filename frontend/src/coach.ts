import type { CoachMessage } from '../../mobile/src/core/apiClient.ts';
import { SseParser } from '../../mobile/src/core/coach.ts';
import { accountFetch } from './api.ts';
import type { ShootingHand } from './practice.ts';

export const maxCoachQuestionLength = 2000;
export type RecentChat = { sessionId: string; title: string; reply: string; updatedAt: number };
type OnDeviceShot = {
  releaseMs: number;
  shootingHand: ShootingHand;
  releaseElbowDeg: number | null;
  kneeDipDeg: number | null;
  releaseHeight: number | null;
};

export function createSessionCoach(
  baseUrl: string, sessionId: string, token: (refresh: boolean) => Promise<string | null>, fetchApi?: typeof fetch,
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
      onToken?: (token: string) => void, onDeviceShot?: OnDeviceShot, shootingHand?: ShootingHand) {
      const response = await request({
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, onDeviceShot, shootingHand }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      await check(response);
      const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
      if (!reader) throw new Error('The coach did not open a reply stream.');
      const parser = new SseParser();
      try {
        for (;;) {
          const { done, value } = await reader.read();
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
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
