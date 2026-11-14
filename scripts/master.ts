/**
 * Master workflow: one command that takes the backend from source to a
 * verified phone⇄laptop connection, and checks the result against the
 * acceptance list in PROJECT_CONTEXT.md.
 *
 *   npm run master            (150 simulated iterations)
 *   SIM_ITERATIONS=500 npm run master
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const REPORTS = join(ROOT, 'reports');
const PORT = Number(process.env.SMOKE_PORT ?? 3911);
const MIN_ITERATIONS = 100;
/** A hung child (e.g. a wedged sim) fails its step instead of hanging the master forever. */
const STEP_TIMEOUT_MS = Number(process.env.MASTER_STEP_TIMEOUT_MS ?? 10 * 60_000);
/** The master's own report path; never inherited from the shell. */
const SIM_REPORT = join(REPORTS, 'sim-master.json');

interface Step {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}
const steps: Step[] = [];

function sh(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv.SIM_ONLY; // a subset (or an empty value) would skew or wedge the master's sim run
    // Own process group, so a timeout can kill tsx's node grandchild too; killing only the
    // direct child leaves the grandchild holding the pipes open and 'close' never fires.
    const child = spawn(cmd, args, { cwd: ROOT, env: childEnv, detached: true });
    let out = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    const timer = setTimeout(() => {
      out += `\n[master] killed after ${STEP_TIMEOUT_MS} ms without finishing`;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      child.stdout.destroy();
      child.stderr.destroy();
      finish(124);
    }, STEP_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => {
      out += `\n[master] failed to start ${cmd}: ${err.message}`;
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

async function step(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  process.stdout.write(`▸ ${name} … `);
  try {
    const detail = await fn();
    steps.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log('ok');
  } catch (err) {
    steps.push({ name, ok: false, ms: Date.now() - t0, detail: (err as Error).message });
    console.log('FAILED');
    console.error((err as Error).message.split('\n').slice(-25).join('\n'));
  }
}

const tsx = join(ROOT, 'node_modules', '.bin', 'tsx');
const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');

await step('Brief present (PROJECT_CONTEXT.md)', async () => {
  const brief = await readFile(join(ROOT, 'PROJECT_CONTEXT.md'), 'utf8');
  for (const must of ['GET /health', '/v1/demos', 'downloaded_demos', 'sessions', 'shots']) {
    if (!brief.includes(must)) throw new Error(`brief no longer mentions ${must}; re-review the API contract`);
  }
  return 'API contract and tables referenced by the brief are still the ones implemented';
});

await step('Typecheck laptop API + phone core + simulator', async () => {
  const r = await sh(tsc, ['--noEmit', '-p', 'tsconfig.json']);
  if (r.code) throw new Error(r.out);
  return 'tsc --noEmit clean';
});

await step('Typecheck the iPhone adapter against the real Expo SDK', async () => {
  if (!existsSync(join(ROOT, 'mobile', 'node_modules', 'expo'))) {
    throw new Error('mobile/node_modules is missing: run `npm install` inside mobile/ so adapters/expo.ts can be checked');
  }
  const r = await sh(tsc, ['--noEmit', '-p', 'mobile/tsconfig.json']);
  if (r.code) throw new Error(r.out);
  return 'mobile/src (core + adapters/expo.ts) clean against installed Expo types';
});

await step('Server unit tests', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'server', 'package.json'), 'utf8'));
  if (!pkg.scripts?.test) throw new Error('server/package.json has no "test" script; the server must ship unit tests');
  const r = await sh('npm', ['test', '-w', 'server']);
  if (r.code) throw new Error(r.out);
  // node:test prints "ℹ tests 52" (spec reporter) or "# tests 52" (TAP).
  const counts = r.out.match(/^[ℹ#] (tests|pass|fail|skipped) \d+$/gm)?.map((l) => l.slice(2));
  return counts?.join(', ') ?? 'passed';
});

await step('Placeholder model export (until the Blender animation lands)', async () => {
  const file = join(ROOT, 'server', 'media', 'three-point-follow-through-v1.usdz');
  if (existsSync(file)) return 'export already present, left untouched';
  const r = await sh(tsx, ['server/scripts/make-placeholder-usdz.ts', file]);
  if (r.code) throw new Error(r.out);
  return r.out.trim();
});

await step('Sync catalog sizeBytes with actual exports', async () => {
  const r = await sh(tsx, ['server/scripts/sync-catalog.ts']);
  if (r.code) throw new Error(r.out);
  return r.out.trim();
});

await step(`Smoke-test the real server process on :${PORT}`, async () => {
  const base = `http://127.0.0.1:${PORT}`;
  // Anything already answering would make this step validate someone else's (old) server.
  const squatter = await fetch(`${base}/health`).then(
    () => true,
    () => false,
  );
  if (squatter) throw new Error(`port ${PORT} is already in use (a stale server?). Stop it or set SMOKE_PORT.`);

  const child = spawn(tsx, ['server/src/server.ts'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' } });
  let log = '';
  let exited: number | null | undefined;
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  child.on('exit', (code) => (exited = code));
  try {
    for (let i = 0; ; i++) {
      if (exited !== undefined) throw new Error(`server process exited (${exited}) before answering:\n${log}`);
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {}
      if (i > 60) throw new Error(`server did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    if (exited !== undefined) throw new Error(`server process exited (${exited}); /health came from another process`);
    const demos = (await (await fetch(`${base}/v1/demos?shotType=three_point`)).json()) as any[];
    if (!Array.isArray(demos) || demos.length !== 1) throw new Error(`unexpected catalog ${JSON.stringify(demos)}`);
    const asset = demos[0].assets[0];
    const res = await fetch(/^https:\/\//.test(asset.url) ? asset.url : base + asset.url);
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || body.length !== asset.sizeBytes) {
      throw new Error(`media ${res.status}, ${body.length} bytes vs catalog ${asset.sizeBytes}`);
    }
    if (body.readUInt32LE(0) !== 0x04034b50) throw new Error('served model is not a USDZ (zip) container');
    const bad = await fetch(`${base}/v1/demos?shotType=../../etc`);
    if (bad.status !== 400) throw new Error(`invalid shotType returned ${bad.status}`);
    const trav = await fetch(`${base}/media/..%2Fcatalog%2Fdemos.json`);
    if (trav.status === 200) throw new Error('path traversal served a file outside media/');
    return `health ok, catalog ok, ${asset.url} served ${body.length} bytes, bad input rejected`;
  } finally {
    child.kill('SIGTERM');
  }
});

let sim: any = null;
await step('Phone ⇄ laptop connection simulation', async () => {
  const iterations = Math.max(MIN_ITERATIONS, Number(process.env.SIM_ITERATIONS ?? 150));
  const seed = String(process.env.SIM_SEED ?? Date.now() % 1_000_000);
  // Never judge a stale report: delete it, pin its path, and check it describes this run.
  await mkdir(REPORTS, { recursive: true });
  await rm(SIM_REPORT, { force: true });
  const started = Date.now();
  const r = await sh(tsx, ['sim/run.ts'], {
    SIM_ITERATIONS: String(iterations),
    SIM_SEED: seed,
    SIM_REPORT,
    SIM_SANDBOX: join(ROOT, 'sim', '.sandbox-master'),
  });
  if (!existsSync(SIM_REPORT)) throw new Error(`sim wrote no report (exit ${r.code}):\n${r.out}`);
  const report = JSON.parse(await readFile(SIM_REPORT, 'utf8'));
  if ((await stat(SIM_REPORT)).mtimeMs < started || String(report.seed) !== seed || report.iterations !== iterations) {
    throw new Error(`sim report does not describe this run (seed ${report.seed}, ${report.iterations} iterations)`);
  }
  if (r.code || report.failed) throw new Error(r.out);

  // Every scenario branch must have run at least once, or a regression in it can pass unseen.
  if (!report.branches || typeof report.branches !== 'object') throw new Error('sim report has no branch coverage');
  const unexercised = Object.entries(report.branches as Record<string, Record<string, number>>).flatMap(([sc, b]) =>
    Object.entries(b)
      .filter(([, n]) => !n)
      .map(([name]) => `${sc}:${name}`),
  );
  if (unexercised.length) throw new Error(`branches never exercised this run: ${unexercised.join(', ')}`);
  const branchCount = Object.values(report.branches as Record<string, object>).reduce((n, b) => n + Object.keys(b).length, 0);

  sim = report; // only a verified, passing report feeds the acceptance checklist
  return `${sim.passed}/${sim.iterations} passed (seed ${sim.seed}), ${branchCount} branches all exercised, ${sim.phonesSimulated} phones, ${sim.relaunches} relaunches, ${sim.injectedDrops} injected drops`;
});

// Acceptance items from PROJECT_CONTEXT.md mapped to the scenarios that prove them.
const ACCEPTANCE: [string, string[]][] = [
  ['Recording moves out of camera cache, keeps its extension, and reopens after relaunch', ['record_tag_restart', 'row_change_fails']],
  ['Saved clips, shot numbers and stats survive an app update (schema migration, incl. a kill mid-migration)', ['migrate_v1_database']],
  ['Shot tags (made/missed/unmarked) and edits update stored totals; empty state when 0 attempts', ['record_tag_restart', 'edit_shots_and_history']],
  ['Removing a video reclaims space but keeps the session stats (unavailable replay)', ['remove_video_keeps_stats', 'remove_video_twice', 'damaged_files', 'row_change_fails']],
  ['Check free space before recording or downloading', ['low_disk', 'storage_usage_accounting']],
  ['GET /health and GET /v1/demos?shotType= contract; relative + https asset URLs', ['api_contract', 'fresh_install_download']],
  ['Download → temp file → verify byte size → persist → save metadata', ['fresh_install_download', 'size_mismatch_catalog']],
  ['Newer catalog version downloads and replaces the old one', ['version_upgrade']],
  ['Last working model kept when a replacement download fails', ['truncated_download_keeps_last', 'asset_404', 'server_error_500', 'garbage_catalog']],
  ['Laptop off: downloaded model + cue reopen offline after relaunch', ['relaunch_offline_reopen', 'crash_recovery', 'damaged_files', 'not_configured']],
  ['Laptop unreachable and no model: retry state, then recovers', ['unreachable_no_model', 'slow_network_timeout', 'not_configured']],
  ['Recording/tagging work while the laptop is unreachable or a download is in flight', ['record_tag_restart', 'record_during_download']],
  ['Repeated taps do not start duplicate downloads', ['concurrent_taps']],
  ['Rapid shot tagging never collides (expo-sqlite transaction semantics)', ['rapid_tagging']],
  ['Deleting a session removes its row, shots, and video', ['delete_session']],
  ['No demo for the drill: retry state; saved model still opens', ['catalog_no_entry']],
  ['A selected (pinned) catalog version downloads and reopens offline', ['pinned_version']],
  ['Asset URL on the API origin (absolute http) downloads correctly', ['same_origin_http_url']],
  ['App killed mid-download, at any await point, or during launch: disk and SQLite stay consistent', ['kill_mid_download', 'kill_at_each_await_point', 'kill_during_launch', 'kill_during_save', 'kill_during_delete', 'kill_after_resolved_delete']],
  ['A body larger than the catalog says is stopped early; the last model is kept', ['oversize_media']],
  ['Overlapping opens of different versions: each gets an existing model, one kept, no downgrade', ['overlapping_versions']],
  ['A double-tapped Save stores one session; the other gets recording_missing', ['double_save_recording']],
  ['A stalled catalog body times out and later opens still work', ['stalled_catalog_body']],
  ['Signed-in tagging syncs one clip per shot (3 s before to 1 s after release, frame-accurate); the full recording leaves Blob', ['clip_sync_windows', 'clip_sync_concurrent']],
  ['Signed out: nothing is uploaded or queued, even after a later sign-in', ['clip_sync_signed_out']],
  ['Offline, expired token, or server error leaves shots pending; the next sync succeeds', ['clip_sync_retry']],
  ['Outcome edit → PATCH; deleting a shot or session → remote DELETE', ['clip_sync_edits']],
  ['A player only ever sees or changes their own clips', ['clip_sync_isolation']],
  ['Video removed before sync, or release past the end, makes the shot unavailable', ['clip_sync_video_removed', 'clip_sync_release_beyond_end']],
  ['A kill anywhere in a sync costs at most one repeated upload; no clip lost or duplicated', ['clip_sync_kill_sweep']],
  ['A sync never blocks recording, tagging, or replay', ['clip_sync_responsive']],
];

const acceptance = ACCEPTANCE.map(([item, scenarios]) => {
  const ok = !!sim && scenarios.every((s) => sim.scenarios[s]?.runs > 0 && sim.scenarios[s].fail === 0);
  return { item, scenarios, ok };
});

const manual = [
  'Verify the placeholder (and later the finished catch-and-shoot animation) in Quick Look on the demo iPhone.',
  'On an installed preview build: Wi-Fi off → quit → relaunch → record, reopen a session, play the 3D model.',
  'Confirm the iOS Local Network permission prompt appears and EXPO_PUBLIC_API_URL points at the laptop LAN IP.',
];

const allOk = steps.every((s) => s.ok) && acceptance.every((a) => a.ok);
const md = [
  `# Perspective master run — ${new Date().toISOString()}`,
  '',
  `**Result: ${allOk ? 'PASS' : 'FAIL'}**`,
  '',
  '## Steps',
  '',
  '| Step | Result | Time | Detail |',
  '| --- | --- | --- | --- |',
  ...steps.map((s) => `| ${s.name} | ${s.ok ? 'ok' : '**FAILED**'} | ${s.ms} ms | ${s.detail.split('\n')[0]!.replace(/\|/g, '\\|')} |`),
  '',
  '## Acceptance (PROJECT_CONTEXT.md) covered by simulation',
  '',
  ...acceptance.map((a) => `- [${a.ok ? 'x' : ' '}] ${a.item} — _${a.scenarios.join(', ')}_`),
  '',
  '## Still needs a real iPhone',
  '',
  ...manual.map((m) => `- [ ] ${m}`),
  '',
].join('\n');

await mkdir(REPORTS, { recursive: true });
await writeFile(join(REPORTS, 'master-report.md'), md);
console.log(`\n${allOk ? 'PASS' : 'FAIL'} — report: reports/master-report.md`);
process.exitCode = allOk ? 0 : 1;
