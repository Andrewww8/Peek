/**
 * The real ChatAnthropic (no network): a fake SDK client is injected through
 * `createClient`, so these tests see the exact request body @langchain/anthropic
 * sends, and can script Sonnet 5.5-style streamed responses with thinking blocks.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.js';
import { paths } from '../deps.js';
import { createLocalDeps, signLocalToken } from '../local/index.js';
import { anthropicModelFactory } from './agent.js';

const SECRET = 'anthropic-wire-secret';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SESSION = randomUUID();

type Block = { type: 'thinking'; thinking: string; signature: string } | { type: 'text'; text: string };

/** Anthropic streaming events for one assistant message. */
function* events(blocks: Block[], id: string) {
  yield { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 } } };
  for (const [index, b] of blocks.entries()) {
    if (b.type === 'thinking') {
      yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } };
      yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } };
      yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } };
    } else {
      yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
      for (const part of b.text.match(/.{1,6}/g) ?? []) yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } };
    }
    yield { type: 'content_block_stop', index };
  }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } };
  yield { type: 'message_stop' };
}

function fakeAnthropic(responses: Block[][]) {
  const requests: { api: 'beta' | 'messages'; params: any }[] = [];
  let i = 0;
  const create = (api: 'beta' | 'messages') => async (params: any) => {
    requests.push({ api, params: structuredClone(params) });
    const blocks = responses[i++] ?? [{ type: 'text', text: 'out of script' }];
    const id = `msg_${i}`;
    if (params.stream) {
      const gen = events(blocks, id);
      return { [Symbol.asyncIterator]: async function* () { yield* gen; }, controller: new AbortController() };
    }
    return { id, type: 'message', role: 'assistant', model: params.model, content: blocks, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
  };
  const client = { beta: { messages: { create: create('beta') } }, messages: { create: create('messages') } };
  return { client, requests };
}

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perspective-anthropic-'));
  await mkdir(join(dir, 'media'));
  await writeFile(join(dir, 'demos.json'), '[]');
});
after(() => rm(dir, { recursive: true, force: true }));

async function appWith(fake: ReturnType<typeof fakeAnthropic>) {
  const deps = createLocalDeps(join(dir, randomUUID()), {
    jwtSecret: SECRET,
    inMemory: true,
    coachModel: anthropicModelFactory('test-key', { createClient: () => fake.client }),
    trimmer: { probeDurationMs: async () => 0, trim: async () => {} },
  });
  await deps.clips.upsert({ userId: A, sessionId: SESSION, shotNumber: 1, shotType: 'three_point', releaseMs: 3000, outcome: 'made', clipPathname: paths.clip(A, SESSION, 1), startMs: 0, endMs: 4000, sizeBytes: 1 });
  const app = await buildApp({ catalogPath: join(dir, 'demos.json'), mediaDir: join(dir, 'media'), deps });
  const token = await signLocalToken(SECRET, A);
  const say = (message: string) => app.inject({ method: 'POST', url: `/v1/sessions/${SESSION}/coach/messages`, headers: { authorization: `Bearer ${token}` }, payload: { message } });
  return { app, say, deps };
}

describe('@langchain/anthropic on the wire', () => {
  test('effort medium, refusal fallbacks via the beta API, prompt caching, default thinking, no forced tool_choice', async () => {
    const fake = fakeAnthropic([[{ type: 'text', text: 'Hello shooter.' }]]);
    const { app, say } = await appWith(fake);
    assert.equal((await say('Hi coach')).statusCode, 200);
    const [req] = fake.requests;
    assert.equal(req!.api, 'beta', 'betas route the call to client.beta.messages.create');
    const p = req!.params;
    assert.equal(p.model, 'claude-sonnet-5-5');
    assert.equal(p.max_tokens, 16_000);
    assert.equal(p.stream, true);
    assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(p.fallbacks, 'default');
    assert.deepEqual(p.output_config, { effort: 'medium' });
    assert.equal('thinking' in p && p.thinking !== undefined, false, 'thinking unset: the model default (adaptive) applies');
    assert.equal(p.tool_choice, undefined);
    assert.ok(p.tools.some((t: any) => t.name === 'get_shot_metrics') && p.tools.some((t: any) => t.name === 'task'));
    assert.ok(JSON.stringify(p.system).includes("Perspective's basketball shooting coach"));
    assert.match(JSON.stringify([p.system, p.messages, p.tools, p.cache_control ?? null]), /"cache_control":\{"type":"ephemeral"/, 'a prompt-cache breakpoint is set');
    assert.doesNotMatch(JSON.stringify(p), /createdAt/, 'history metadata never reaches the API');
    await app.close();
  });

  test('thinking blocks round-trip unchanged through the checkpointer, and never reach the player', async () => {
    const thinking = { type: 'thinking' as const, thinking: 'The player asked about shot 1; no tools needed yet.', signature: 'EqQBCkYIBhgCKkD+sig/with+chars==' };
    const fake = fakeAnthropic([[thinking, { type: 'text', text: 'Hello shooter.' }], [{ type: 'text', text: 'Second answer.' }]]);
    const { app, say } = await appWith(fake);
    const first = await say('Hi coach');
    assert.doesNotMatch(first.payload, /no tools needed/, 'thinking text is not streamed');
    assert.match(first.payload, /event: token\ndata: \{"text":"Hello "\}/);
    assert.match(first.payload, /event: done\ndata: \{"messageId":"[^"]+","text":"Hello shooter\."\}/);
    await say('And now?');
    const second = fake.requests[1]!.params;
    const assistant = second.messages.find((m: any) => m.role === 'assistant');
    assert.ok(assistant, 'the first reply is replayed');
    assert.deepEqual(assistant.content[0], thinking, 'thinking text and signature are byte-identical');
    assert.deepEqual(assistant.content[1], { type: 'text', text: 'Hello shooter.' });
    await app.close();
  });
});
