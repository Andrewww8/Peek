/**
 * A scripted tool-calling chat model for the coach, so the simulator never
 * calls a real LLM. Each scenario installs a script that decides the next
 * reply from the conversation so far: tool calls, or text. Text replies are
 * streamed in several chunks (optionally slowly), so the API's SSE token
 * events and the phone's parser see a real stream; tool calls arrive as
 * tool-call chunks, as Anthropic streams them.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';

export type ScriptReply =
  | { tools: { name: string; args: Record<string, unknown> }[]; delayMs?: number }
  | { text: string; chunks?: number; chunkDelayMs?: number; delayMs?: number };

export interface ScriptTurn {
  /** The latest user message. */
  human: string;
  /** Tool results returned since that message, parsed as JSON where possible. */
  results: { name: string; content: unknown }[];
  messages: BaseMessage[];
}

export type Script = (turn: ScriptTurn) => ScriptReply | Promise<ScriptReply>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ids = 0;

function turnOf(messages: BaseMessage[]): ScriptTurn {
  let last = -1;
  messages.forEach((m, i) => {
    if (HumanMessage.isInstance(m)) last = i;
  });
  const human = last >= 0 ? String(messages[last]!.text ?? '') : '';
  const results = messages.slice(last + 1).filter((m): m is ToolMessage => ToolMessage.isInstance(m)).map((m) => {
    const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    let content: unknown = raw;
    try {
      content = JSON.parse(raw);
    } catch {
      // plain text
    }
    return { name: m.name ?? '', content };
  });
  return { human, results, messages };
}

function split(text: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, n)));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export class ScriptedChatModel extends BaseChatModel {
  /** Replaced per scenario. The default fails the turn loudly. */
  script: Script = () => {
    throw new Error('sim: no coach script installed');
  };
  calls = 0;
  readonly seen: ScriptTurn[] = [];

  constructor() {
    super({});
  }

  _llmType() {
    return 'sim-scripted';
  }

  /** Same instance with tools bound: all state is shared, like fakeModel. */
  bindTools(): this {
    return this;
  }

  private async next(messages: BaseMessage[]) {
    this.calls++;
    const turn = turnOf(messages);
    this.seen.push(turn);
    const reply = await this.script(turn);
    if (reply.delayMs) await sleep(reply.delayMs);
    return reply;
  }

  private static toolMessage(reply: Extract<ScriptReply, { tools: unknown }>) {
    return new AIMessage({
      content: '',
      tool_calls: reply.tools.map((t) => ({ id: `sim_call_${++ids}`, name: t.name, args: t.args, type: 'tool_call' as const })),
    });
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const reply = await this.next(messages);
    const message = 'tools' in reply ? ScriptedChatModel.toolMessage(reply) : new AIMessage(reply.text);
    return { generations: [{ text: 'text' in reply ? reply.text : '', message }] };
  }

  async *_streamResponseChunks(messages: BaseMessage[], _options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun) {
    const reply = await this.next(messages);
    if ('tools' in reply) {
      const tool_call_chunks = reply.tools.map((t, index) => ({ id: `sim_call_${++ids}`, name: t.name, args: JSON.stringify(t.args), index, type: 'tool_call_chunk' as const }));
      yield new ChatGenerationChunk({ text: '', message: new AIMessageChunk({ content: '', tool_call_chunks }) });
      return;
    }
    for (const piece of split(reply.text, reply.chunks ?? 6)) {
      if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
      yield new ChatGenerationChunk({ text: piece, message: new AIMessageChunk({ content: piece }) });
      await runManager?.handleLLMNewToken(piece);
    }
  }
}
