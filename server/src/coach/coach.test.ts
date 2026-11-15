import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { analyzeClipNpz } from '../cv/metrics.js';
import { SHOT, syntheticShot, writeNpz } from '../cv/test-pose.js';
import { paths } from '../deps.js';
import { createLocalDeps, signLocalToken, type LocalDeps } from '../local/index.js';
import type { ModelRole } from './deps.js';
import { createCoachTools } from './tools.js';

const SECRET = 'coach-test-secret';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
type Fake = ReturnType<typeof fakeModel>;

let dir: string;
let tokenA: string;
let tokenB: string;
const sessionA = randomUUID();
const sessionB = randomUUID();
const analysis = analyzeClipNpz(writeNpz([{ track: 1, series: syntheticShot() }]), { startMs: 0, releaseMs: Math.round((SHOT.release * 1000) / SHOT.fps), endMs: 4000 });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perspective-coach-'));
  await mkdir(join(dir, 'media'));
  await writeFile(join(dir, 'demos.json'), '[]');
  tokenA = await signLocalToken(SECRET, A);
  tokenB = await signLocalToken(SECRET, B);
});
after(() => rm(dir, { recursive: true, force: true }));

const toolCall = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: '', tool_calls: [{ id: `call_${randomUUID().slice(0, 8)}`, name, args, type: 'tool_call' }] });

/** An app whose coach runs on fake models: `coach` for the main agent, `analyst` for the subagent. */
async function coachApp(o: { coach: Fake; analyst?: Fake; dailyLimit?: number; recursionLimit?: number; keepAliveMs?: number } ) {
  const deps: LocalDeps = createLocalDeps(join(dir, randomUUID()), {
    jwtSecret: SECRET,
    inMemory: true,
    coachModel: (role: ModelRole) => (role === 'coach' ? o.coach : (o.analyst ?? fakeModel())) as never,
    coachDailyLimit: o.dailyLimit,
    coachRecursionLimit: o.recursionLimit,
    coachKeepAliveMs: o.keepAliveMs,
    trimmer: { probeDurationMs: async () => 0, trim: async () => {} },
  });
  // A: shot 1 made (analyzed), shot 2 missed (analyzed), shot 3 pending. B: one shot with a different outcome.
  for (const [userId, sessionId, n, outcome] of [[A, sessionA, 1, 'made'], [A, sessionA, 2, 'missed'], [A, sessionA, 3, 'made'], [B, sessionB, 1, 'missed']] as const) {
    await deps.clips.upsert({ userId, sessionId, shotNumber: n, shotType: 'three_point', releaseMs: 3000, outcome, clipPathname: paths.clip(userId, sessionId, n), startMs: 0, endMs: 4000, sizeBytes: 10 });
    if (n !== 3) await deps.clips.setAnalysis(userId, sessionId, n, 'complete', userId === B ? { ...analysis, metrics: { ...analysis.metrics, elbowAngleReleaseDeg: 111.1 } } : analysis);
  }
  const app = await buildApp({ catalogPath: join(dir, 'demos.json'), mediaDir: join(dir, 'media'), deps });
  return { app, deps };
}

interface Sse {
  events: { event: string; data: any }[];
  pings: number;
}
function parseSse(payload: string): Sse {
  const out: Sse = { events: [], pings: 0 };
  for (const block of payload.split('\n\n')) {
    if (!block.trim()) continue;
    if (block.startsWith(':')) {
      out.pings++;
      continue;
    }
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    assert.ok(event && data, `malformed SSE block: ${block}`);
    out.events.push({ event, data: JSON.parse(data) });
  }
  return out;
}
const send = (app: FastifyInstance, message: unknown, token = tokenA, sessionId = sessionA, onDeviceShot?: unknown) =>
  app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/coach/messages`, headers: { authorization: `Bearer ${token}` }, payload: { message, onDeviceShot } as object });
const history = async (app: FastifyInstance, token = tokenA, sessionId = sessionA) => {
  const res = await app.inject({ url: `/v1/sessions/${sessionId}/coach/messages`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200, res.payload);
  return res.json().messages as { id: string; role: string; text: string; createdAt: string }[];
};
/** Tool results the model has seen so far (each call re-sends the whole conversation, so read the last one). */
const toolResults = (fake: Fake) => (fake.calls.at(-1)?.messages ?? []).filter((m): m is ToolMessage => ToolMessage.isInstance(m as BaseMessage));

describe('coach chat over SSE', () => {
  test('streams tool_status, token and done events in the phone\'s wire format', async () => {
    const coach = fakeModel()
      .respond(toolCall('get_shot_metrics', { shotNumber: 1 }))
      .respond(new AIMessage({ content: 'Shot 1: your elbow reached 170° at release. Hold your finish.', usage_metadata: { input_tokens: 120, output_tokens: 30, total_tokens: 150, input_token_details: { cache_read: 100, cache_creation: 20 } } }));
    const { app, deps } = await coachApp({ coach });
    const res = await send(app, 'How was shot 1?');
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    const { events } = parseSse(res.payload);
    assert.deepEqual(events.map((e) => e.event), ['tool_status', 'token', 'done']);
    assert.deepEqual(events[0]!.data, { tool: 'shot_metrics', message: 'Looking at shot 1…' });
    assert.deepEqual(events[1]!.data, { text: 'Shot 1: your elbow reached 170° at release. Hold your finish.' });
    assert.equal(events[2]!.data.text, events[1]!.data.text);
    assert.equal(typeof events[2]!.data.messageId, 'string');
    // The model saw the tool's numbers.
    assert.match(String(toolResults(coach)[0]!.content), /"elbowAngleReleaseDeg":170/);
    // Usage was counted and logged for the day.
    const [row] = deps.usage.rows();
    assert.deepEqual([row!.messages, row!.turns, row!.inputTokens, row!.outputTokens, row!.cacheReadTokens, row!.cacheCreationTokens], [1, 1, 120, 30, 100, 20]);
    // No forced tool choice is ever sent.
    assert.ok(coach.calls.every((c) => (c.options as Record<string, unknown>)?.tool_choice === undefined));
    await app.close();
  });

  test('tools read the player and session from the request context, even when the model names another player\'s session', async () => {
    const coach = fakeModel()
      .respond(toolCall('get_shot_metrics', { shotNumber: 1, userId: B, sessionId: sessionB }))
      .respond(toolCall('get_session_overview', { sessionId: sessionB }))
      .respond(new AIMessage('ok'));
    const { app } = await coachApp({ coach });
    await send(app, 'Show me shot 1');
    const [metrics, overview] = toolResults(coach);
    assert.match(String(metrics!.content), /"outcome":"made"/, "A's shot 1, not B's (missed)");
    assert.doesNotMatch(String(metrics!.content), /111\.1/);
    assert.equal(JSON.parse(String(overview!.content)).shots.length, 3, "A's three shots");
    await app.close();
  });

  test('history returns user and assistant text only, persists across turns, and DELETE resets it', async () => {
    const coach = fakeModel()
      .respond(toolCall('get_session_overview', {}))
      .respond(new AIMessage('You made 2 of 3.'))
      .respond(new AIMessage('Focus on your follow-through.'));
    const { app } = await coachApp({ coach });
    await send(app, 'How did I do?');
    await send(app, 'What should I work on?');
    const msgs = await history(app);
    assert.deepEqual(msgs.map((m) => [m.role, m.text]), [
      ['user', 'How did I do?'],
      ['assistant', 'You made 2 of 3.'],
      ['user', 'What should I work on?'],
      ['assistant', 'Focus on your follow-through.'],
    ]);
    for (const m of msgs) {
      assert.equal(typeof m.id, 'string');
      assert.ok(!Number.isNaN(Date.parse(m.createdAt)), `createdAt ${m.createdAt}`);
    }
    assert.deepEqual(await history(app, tokenB, sessionB), [], "B's thread is separate");
    const del = await app.inject({ method: 'DELETE', url: `/v1/sessions/${sessionA}/coach`, headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(del.statusCode, 204);
    assert.deepEqual(await history(app), []);
    await app.close();
  });

  test('the daily cap answers 429 coach_daily_limit', async () => {
    const coach = fakeModel().respond(new AIMessage('one')).respond(new AIMessage('two')).respond(new AIMessage('three'));
    const { app, deps } = await coachApp({ coach, dailyLimit: 2 });
    assert.equal((await send(app, 'a')).statusCode, 200);
    assert.equal((await send(app, 'b')).statusCode, 200);
    const third = await send(app, 'c');
    assert.deepEqual([third.statusCode, third.json().error], [429, 'coach_daily_limit']);
    assert.equal(deps.usage.rows()[0]!.messages, 2);
    assert.equal(coach.calls.length, 2, 'the capped message never reached the model');
    await app.close();
  });

  test('401 without a token and 400 for a bad message or an invalid estimate', async () => {
    const { app } = await coachApp({ coach: fakeModel() });
    const noAuth = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionA}/coach/messages`, payload: { message: 'hi' } });
    assert.deepEqual([noAuth.statusCode, noAuth.json().error], [401, 'unauthorized']);
    for (const message of ['', '   ', 'x'.repeat(2001), 42]) {
      const res = await send(app, message);
      assert.deepEqual([res.statusCode, res.json().error], [400, 'invalid_request']);
    }
    const bad = await send(app, 'hi', tokenA, sessionA, {
      releaseMs: 2000, shootingHand: 'right', releaseElbowDeg: 181, kneeDipDeg: null, releaseHeight: 0.2,
    });
    assert.deepEqual([bad.statusCode, bad.json().error], [400, 'invalid_request']);
    await app.close();
  });

  test('guest and registered players start general chat without synced clips and keep threads private', async () => {
    const coach = fakeModel()
      .respond(new AIMessage('Private session answer.'))
      .respond(toolCall('get_session_overview', {}))
      .respond(new AIMessage('Finish with a relaxed wrist.'))
      .respond(toolCall('get_session_overview', {}))
      .respond(new AIMessage('Set your feet first.'));
    const { app } = await coachApp({ coach });
    const guest = await signLocalToken(SECRET, B, 3600, true);
    await send(app, 'Private shot question');
    for (const [token, thread, expected] of [[guest, sessionA, 'Finish with a relaxed wrist.'], [tokenA, randomUUID(), 'Set your feet first.']] as const) {
      const response = await send(app, 'How should I practice?', token, thread);
      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(parseSse(response.payload).events.at(-1)?.data.text, expected);
      assert.deepEqual(JSON.parse(String(toolResults(coach).at(-1)!.content)).shots, []);
      assert.deepEqual((await history(app, token, thread)).map((message) => message.text), ['How should I practice?', expected]);
    }
    assert.deepEqual((await history(app)).map((message) => message.text), ['Private shot question', 'Private session answer.']);
    await app.close();
  });

  test('unlimited guests can send more than five Coach messages while registered limits still apply', async () => {
    const coach = fakeModel();
    for (let i = 0; i < 7; i++) coach.respond(new AIMessage('Keep your wrist relaxed.'));
    const { app, deps } = await coachApp({ coach, dailyLimit: 1 });
    try {
      const guest = await signLocalToken(SECRET, B, 3600, true);
      for (let i = 0; i < 6; i++) {
        const res = await send(app, `Guest question ${i + 1}`, guest, sessionB);
        assert.equal(res.statusCode, 200, res.payload);
        assert.equal(parseSse(res.payload).events.at(-1)?.data.text, 'Keep your wrist relaxed.');
      }
      assert.equal(deps.usage.rows().filter(({ userId }) => userId === B).reduce((count, row) => count + row.messages, 0), 6);
      assert.equal((await send(app, 'Registered question')).statusCode, 200);
      const limited = await send(app, 'Registered follow-up');
      assert.deepEqual([limited.statusCode, limited.json().error], [429, 'coach_daily_limit']);
    } finally {
      await app.close();
    }
  });

  test('Coach sees validated on-device estimates when synced form data is unavailable', async () => {
    const coach = fakeModel();
    for (let i = 0; i < 3; i++) coach.respond(toolCall('get_session_overview', {})).respond(new AIMessage('ok'));
    const { app } = await coachApp({ coach });
    const unsynced = randomUUID();
    const estimate = { releaseMs: 2000, shootingHand: 'right', releaseElbowDeg: 162, kneeDipDeg: null, releaseHeight: 0.2 };
    await send(app, 'How was my footwork?', tokenA, unsynced, { ...estimate, instruction: 'discard this field' });
    const readOverview = () => JSON.parse(String(toolResults(coach).at(-1)!.content));
    assert.deepEqual(readOverview().onDeviceShot, { source: 'iphone_pose_estimate', ...estimate });
    assert.deepEqual(readOverview().shots, []);
    await send(app, 'Any other cue?', tokenA, unsynced);
    assert.equal(readOverview().onDeviceShot, undefined);
    await send(app, 'What about the saved shots?', tokenA, sessionA, estimate);
    assert.equal(readOverview().onDeviceShot, undefined);
    assert.equal(readOverview().shots.length, 3);
    await app.close();
  });

  test('without a model the coach answers 503 not_configured and /health stays ok', async () => {
    const deps = createLocalDeps(join(dir, randomUUID()), { jwtSecret: SECRET, inMemory: true });
    const app = await buildApp({ catalogPath: join(dir, 'demos.json'), mediaDir: join(dir, 'media'), deps });
    const res = await send(app, 'hi');
    assert.deepEqual([res.statusCode, res.json().error], [503, 'not_configured']);
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
    await app.close();
  });

  test('sends `: ping` keep-alives while a tool is slow', async () => {
    const coach = fakeModel().respond(toolCall('get_session_overview', {})).respond(new AIMessage('done'));
    const { app, deps } = await coachApp({ coach, keepAliveMs: 10 });
    const list = deps.clips.list.bind(deps.clips);
    deps.clips.list = async (u, s) => {
      if (s) await new Promise((r) => setTimeout(r, 120));
      return list(u, s);
    };
    const sse = parseSse((await send(app, 'overview?')).payload);
    assert.ok(sse.pings >= 2, `${sse.pings} pings`);
    assert.equal(sse.events.at(-1)!.event, 'done');
    await app.close();
  });

  test('a runaway tool loop stops at the recursion limit with error coach_step_limit', async () => {
    const coach = fakeModel();
    for (let i = 0; i < 30; i++) coach.respond(toolCall('get_session_overview', {}));
    const { app } = await coachApp({ coach, recursionLimit: 6 });
    const { events } = parseSse((await send(app, 'loop')).payload);
    assert.deepEqual(events.at(-1), { event: 'error', data: { code: 'coach_step_limit', message: 'The coach took too many steps on this question.' } });
    await app.close();
  });

  test('a model failure ends the stream with error coach_failed', async () => {
    const { app } = await coachApp({ coach: fakeModel().alwaysThrow(new Error('overloaded')) });
    const { events } = parseSse((await send(app, 'hi')).payload);
    assert.deepEqual(events.at(-1)!.data.code, 'coach_failed');
    await app.close();
  });

  test('"analyze my whole session" delegates to the form-analyst subagent, which also sees only this player', async () => {
    const analyst = fakeModel()
      .respond(toolCall('compare_made_vs_missed', {}))
      .respond(new AIMessage('{"findings":[{"metric":"elbowAngleReleaseDeg","observation":"same on makes and misses","shotNumbers":[1,2]}],"dataQualityNotes":[]}'));
    const coach = fakeModel()
      .respond(toolCall('task', { subagent_type: 'form-analyst', description: 'Analyze the whole session' }))
      .respond(new AIMessage('Your release is consistent across makes and misses.'));
    const { app } = await coachApp({ coach, analyst });
    const { events } = parseSse((await send(app, 'Analyze my whole session')).payload);
    assert.deepEqual(events[0], { event: 'tool_status', data: { tool: 'form_analysis', message: 'Analyzing your whole session…' } });
    assert.equal(events.at(-1)!.event, 'done');
    const cmp = JSON.parse(String(toolResults(analyst)[0]!.content));
    assert.deepEqual([cmp.metrics.elbowAngleReleaseDeg.madeN, cmp.metrics.elbowAngleReleaseDeg.missedN], [1, 1]);
    assert.match(String(toolResults(coach)[0]!.content), /findings/, 'the structured findings came back to the coach');
    assert.ok(analyst.calls.every((c) => (c.options as Record<string, unknown>)?.tool_choice === undefined));
    await app.close();
  });
});

describe('coach tools', () => {
  test('compare_to_reference uses the pro templates (verified broadcast shots are not mixed in), and the other tools work', async () => {
    const deps = createLocalDeps(join(dir, randomUUID()), { jwtSecret: SECRET, inMemory: true });
    await deps.clips.upsert({ userId: A, sessionId: sessionA, shotNumber: 1, shotType: 'three_point', releaseMs: 3000, outcome: 'made', clipPathname: 'x', startMs: 0, endMs: 4000, sizeBytes: 1 });
    await deps.clips.setAnalysis(A, sessionA, 1, 'complete', analysis);
    const tools: Record<string, { invoke: (args: object, config: unknown) => Promise<unknown> }> = Object.fromEntries(
      createCoachTools({ clips: deps.clips, references: deps.references }).map((t) => [t.name, t as never]),
    );
    const run = async (name: string, args: object) => JSON.parse(String(await tools[name]!.invoke(args, { context: { userId: A, sessionId: sessionA } } as never)));
    assert.deepEqual(await run('compare_to_reference', {}), { available: false, shotType: 'three_point', reason: 'No pro templates for this shot type yet.' });
    // A verified raw-broadcast shot does not count as a template.
    const clipId = randomUUID();
    await deps.references.insertClip({ id: clipId, title: 'pro', source: 's', rightsNote: 'r', videoPathname: null, npzPathname: null, fps: 30 });
    await deps.references.insertShots([{ id: randomUUID(), clipId, track: 1, releaseFrame: 90, shotType: 'three_point', verified: true, metrics: analysis }]);
    assert.equal((await run('compare_to_reference', {})).available, false);
    const series = await run('get_shot_timeseries', { shotNumber: 1, signal: 'elbow' });
    assert.equal(series.values.length, 31);
    assert.equal((await run('get_player_history', { metric: 'kneeFlexionMinDeg' })).sessions[0].n, 1);
    assert.equal((await run('get_shot_metrics', { shotNumber: 9 })).error, 'shot_not_found');
    await assert.rejects(tools.get_shot_metrics!.invoke({ shotNumber: 1 }, {} as never), 'no context, no data');
  });
});
