/**
 * Phone ⇄ laptop connection simulation.
 *
 * Starts the real Fastify API, puts a fault-injecting proxy in front of it,
 * and drives the real phone backend (Node adapters in place of Expo) through
 * randomized scenarios. After every iteration it checks that SQLite and the
 * file system still agree on every simulated phone.
 *
 *   SIM_ITERATIONS=150 SIM_SEED=42 npx tsx sim/run.ts
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp } from '../server/src/app';
import { createLocalDeps, signLocalToken, type LocalDeps } from '../server/src/local';
import { makeVideo, videoInfo } from '../server/src/test-video';
import { placeholderUsdz } from '../server/scripts/make-placeholder-usdz';
import { createPerspectiveBackend, type OpenDemoResult, type Outcome, type PerspectiveBackend } from '../mobile/src/core';
import { RECORDING } from '../mobile/src/core/config';
import { SCHEMA_VERSION } from '../mobile/src/core/schema';
import { BackendError } from '../mobile/src/core/errors';
import { OUTCOMES } from '../mobile/src/core/stats';
import { resolveAssetUrl } from '../mobile/src/core/apiClient';
import { createNodePlatform, type NodePlatform } from './nodeAdapters';
import { startFaultProxy, type FaultMode, type FaultProxy } from './faultProxy';

const ITERATIONS = Number(process.env.SIM_ITERATIONS ?? 150);
const SEED = Number(process.env.SIM_SEED ?? Date.now() % 1_000_000);
const ROOT = process.env.SIM_SANDBOX ?? join(import.meta.dirname, '.sandbox');
const REPORT_DIR = join(import.meta.dirname, '..', 'reports');
const REPORT_FILE = process.env.SIM_REPORT ?? join(REPORT_DIR, 'sim-latest.json');
const SHOT = 'three_point';
const DEMO_ID = 'three-point-follow-through';
const CATALOG_TIMEOUT_MS = 300;

// ---------- helpers ----------
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const randInt = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)]!;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const json = (x: unknown) => JSON.stringify(x);

class AssertionFailed extends Error {}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionFailed(msg);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Size of a regular file, or null when it is missing or not a file. */
async function fileSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

// ---------- laptop fixture ----------
interface Published {
  version: number;
  sha: string;
  size: number;
}

interface CatalogOptions {
  /** The laptop has no entry for the three-point drill (only other drills). */
  dropDrill?: boolean;
  /** List every published version, not only the latest (for pinned opens). */
  allVersions?: boolean;
  /** The latest entry advertises a wrong sizeBytes. */
  wrongSize?: boolean;
}

const cueFor = (v: number) => `Hold your finish until the ball reaches the rim. (v${v})`;

class Laptop {
  latest!: Published;
  readonly versions = new Map<number, Published>();
  private opts: CatalogOptions = {};
  private wrongSizeDelta = 1;
  /** Body withheld by publish({ missingFile }) so reset() can restore it. */
  private pending: Buffer | null = null;
  private lastCatalog = '';

  constructor(
    readonly dir: string,
    readonly mediaDir: string,
    readonly catalogPath: string,
  ) {}

  file(v: number) {
    return join(this.mediaDir, `${DEMO_ID}-v${v}.usdz`);
  }

  private async writeCatalog() {
    const o = this.opts;
    const entries: unknown[] = [];
    if (!o.dropDrill) {
      const listed = o.allVersions ? [...this.versions.values()] : [this.latest];
      for (const pub of listed) {
        const size = o.wrongSize && pub === this.latest ? pub.size + this.wrongSizeDelta : pub.size;
        entries.push({
          id: DEMO_ID,
          version: pub.version,
          shotType: SHOT,
          cue: cueFor(pub.version),
          assets: [{ format: 'usdz', sizeBytes: size, url: `/media/${DEMO_ID}-v${pub.version}.usdz` }],
        });
      }
    }
    // A second drill proves filtering by shotType.
    entries.push({ id: 'free-throw-setup', version: 1, shotType: 'free_throw', cue: 'Set your feet.', assets: [{ format: 'usdz', sizeBytes: 10, url: '/media/none.usdz' }] });
    const text = JSON.stringify(entries, null, 2);
    if (text === this.lastCatalog) return;
    // Atomic replace, so the server never reads a half-written catalog.
    const tmp = `${this.catalogPath}.${randomUUID()}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, this.catalogPath);
    this.lastCatalog = text;
  }

  /** Exports a new model version and points the catalog at it. */
  async publish(opts: { wrongSize?: boolean; missingFile?: boolean } = {}): Promise<Published> {
    const v = (this.latest?.version ?? 0) + 1;
    const body = Buffer.concat([placeholderUsdz(), randomBytes(randInt(20_000, 250_000))]);
    if (!opts.missingFile) await writeFile(this.file(v), body);
    const pub = { version: v, sha: sha(body), size: body.length };
    this.latest = pub;
    this.versions.set(v, pub);
    this.pending = opts.missingFile ? body : null;
    this.wrongSizeDelta = randInt(1, 999);
    this.opts = { ...this.opts, wrongSize: opts.wrongSize };
    await this.writeCatalog();
    return pub;
  }

  async setCatalog(opts: CatalogOptions) {
    this.opts = { ...opts };
    await this.writeCatalog();
  }

  /** Back to a healthy laptop: every export on disk, catalog lists the latest version with true sizes. */
  async reset() {
    if (this.pending) await writeFile(this.file(this.latest.version), this.pending);
    this.pending = null;
    this.opts = {};
    await this.writeCatalog();
  }
}

// ---------- cloud fixture ----------
/** A real playable recording (ffmpeg lavfi), generated once per run and copied into each phone's camera cache. */
interface PoolVideo {
  file: string;
  /** Container duration, as the server's probe reads it. */
  durationMs: number;
  frames: number;
  fps: number;
  audio: boolean;
}
let VIDEOS: PoolVideo[] = [];
const VIDEO_FPS = 30;

/** Six videos: 3 s and 30 s (the edges), four random lengths between; alternately with and without audio. */
async function makeVideoPool(dir: string): Promise<PoolVideo[]> {
  await mkdir(dir, { recursive: true });
  const frames = [3 * VIDEO_FPS, 30 * VIDEO_FPS, ...Array.from({ length: 4 }, () => randInt(3 * VIDEO_FPS + 1, 30 * VIDEO_FPS - 1))];
  return Promise.all(
    frames.map(async (n, i) => {
      const file = join(dir, `rec-${i}.mp4`);
      const audio = i % 2 === 0;
      await makeVideo(file, { seconds: n / VIDEO_FPS, fps: VIDEO_FPS, audio });
      const info = await videoInfo(file);
      assert(info.videoCodec && (info.audioCodec !== null) === audio, `video pool: ${file} came out wrong: ${json(info)}`);
      return { file, durationMs: info.durationMs, frames: info.frames, fps: VIDEO_FPS, audio };
    }),
  );
}

type AuthState =
  | { kind: 'signed_out' }
  | { kind: 'user'; user: string }
  | { kind: 'expired'; user: string }
  /** The adapter's session lookup hangs; it gives up after its bound and returns the last session seen. */
  | { kind: 'slow'; user: string };
/** Kept below expo.ts's TOKEN_LOOKUP_MS (3 s) for runtime, but well above the core's authProbeMs (500 ms). */
const SLOW_AUTH_MS = 1_200;

interface Cloud {
  deps: LocalDeps;
  users: { A: string; B: string };
  token(user: string, ttlSec?: number): Promise<string>;
  /** Every session a signed-in phone handed to syncNow, with the phone and the user it synced as. */
  sessions: Map<string, { phone: Phone; user: string }>;
}
let CLOUD!: Cloud;

// ---------- simulated phones ----------
class Phone {
  backend!: PerspectiveBackend;
  platform!: NodePlatform;
  launches = 0;
  freeBytesOverride: number | undefined;
  /** Set to null (or '') to launch a build that has no laptop URL; undefined uses the proxy. */
  apiBase: string | null | undefined;
  /** Who is signed in (Supabase session), read by the auth port on every call. */
  auth: AuthState = { kind: 'signed_out' };
  get user(): string | null {
    return this.auth.kind === 'signed_out' ? null : this.auth.user;
  }
  private async accessToken(): Promise<string | null> {
    const a = this.auth;
    if (a.kind === 'signed_out') return null;
    if (a.kind === 'slow') await new Promise((r) => setTimeout(r, SLOW_AUTH_MS));
    return CLOUD.token(a.user, a.kind === 'expired' ? -60 : 3_600);
  }
  constructor(
    readonly name: string,
    readonly root: string,
    private readonly apiUrl: () => string,
  ) {}

  /**
   * Cold start. With `killAt`, the app dies at that await point of the launch
   * itself (migrations, recovery sweep) and this returns null.
   */
  async launch(killAt?: { call: number; land: boolean }) {
    await mkdir(this.root, { recursive: true });
    this.platform = createNodePlatform(this.root, {
      freeBytes: () => this.freeBytesOverride,
      auth: { getAccessToken: () => this.accessToken() },
    });
    const proc = this.platform.process;
    if (killAt) proc.killAtCall(killAt.call, killAt.land);
    this.launches++;
    const boot = createPerspectiveBackend(this.platform, {
      apiBaseUrl: this.apiBase !== undefined ? this.apiBase : this.apiUrl(),
      catalogTimeoutMs: CATALOG_TIMEOUT_MS,
    });
    const backend = killAt ? await Promise.race([boot, proc.died.then(() => null)]) : await boot;
    proc.disarm();
    if (!backend) return null;
    this.backend = backend;
    return this.backend.recovery;
  }
  get dead() {
    return this.platform?.process.killed ?? false;
  }
  /** iOS terminates the app: nothing it was doing gets to finish or clean up. */
  kill() {
    this.platform.process.kill();
  }
  /** Quit and relaunch (fresh DB connection, fresh in-memory state). After a kill this is a cold start. */
  async relaunch() {
    await this.close();
    return (await this.launch())!;
  }
  async close() {
    if (this.platform && !this.dead && this.backend) await this.backend.close();
  }
  path(...p: string[]) {
    return join(this.root, ...p);
  }
  async fileSha(uri: string) {
    return sha(await readFile(new URL(uri)));
  }
  /**
   * Simulates expo-camera finishing a recording into its temp cache (an
   * encoded file:// URI): a real playable video from the pool.
   */
  async fakeRecording(ext: string, want: (v: PoolVideo) => boolean = () => true) {
    const video = pick(VIDEOS.filter(want));
    const dir = this.path('Caches', 'Camera');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${randomBytes(6).toString('hex')}.${ext}`);
    // A trailing top-level 'free' box (ignored by every MP4 parser) makes each copy's bytes unique.
    const free = Buffer.alloc(24);
    free.writeUInt32BE(24, 0);
    free.write('free', 4, 'ascii');
    randomBytes(16).copy(free, 8);
    await writeFile(file, Buffer.concat([await readFile(video.file), free]));
    return { uri: pathToFileURL(file).href, file, video };
  }
  /** Saves a recording with its real duration (or the given one). */
  async recordSession(durationMs?: number, want?: (v: PoolVideo) => boolean) {
    const clip = await this.fakeRecording(pick(['mov', 'mp4']), want);
    const s = await this.backend.sessions.saveRecording({ tempUri: clip.uri, durationMs: durationMs ?? clip.video.durationMs });
    return Object.assign(s, { video: clip.video });
  }
}

// ---------- world ----------
interface World {
  laptop: Laptop;
  proxy: FaultProxy;
  pool: Phone[];
  fresh(killAt?: { call: number; land: boolean }): Promise<Phone>;
  /** A new phone whose files a scenario prepares before calling launch() itself. */
  unlaunched(): Phone;
  touched: Set<Phone>;
  /** This scenario's next value for a declared branch dimension (cycles; never random). */
  branch(dim: string): string;
  /** Records a declared branch that this scenario runs every time. */
  cover(dim: string, value: string): void;
}

/**
 * Every branch a scenario can take, declared up front so the report lists
 * each one, run or not. A dimension cycles through its values on its own
 * counter, so any scenario that runs twice has reached every branch; seeds
 * only randomize values inside a branch, never whether a branch runs.
 * Scenarios not listed have a single branch, "all".
 */
const BRANCHES: Record<string, Record<string, readonly string[]>> = {
  record_tag_restart: { laptop: ['on', 'off'] },
  rapid_tagging: { laptop: ['on', 'off'] },
  same_origin_http_url: { phone: ['fresh', 'upgrade'] },
  delete_session: { laptop: ['on', 'off'], video: ['kept', 'removed_first'] },
  kill_mid_download: { phone: ['fresh', 'upgrade'], relaunch_laptop: ['on', 'off'] },
  oversize_media: { phone: ['fresh', 'upgrade'], length: ['content_length', 'chunked'] },
  overlapping_versions: {
    variant: ['pinned_and_unpinned', 'publish_mid_download'],
    pinned_phone: ['pool', 'fresh'],
    stall_release: ['before_second', 'after_second'],
  },
  double_save_recording: { laptop: ['on', 'off'] },
  damaged_files: { recovery: ['relaunch', 'open_without_relaunch'] },
  kill_during_launch: { install: ['fresh', 'existing'] },
  kill_during_save: { land: ['before_call', 'after_call'] },
  kill_during_delete: { op: ['deleteSession', 'removeVideo'] },
  kill_after_resolved_delete: { op: ['removeVideo', 'deleteSession'] },
  not_configured: { config: ['null', 'blank'] },
  row_change_fails: { op: ['removeVideo', 'deleteSession', 'saveRecording'] },
  clip_sync_windows: { audio: ['with', 'without'] },
  clip_sync_signed_out: { when: ['signed_out_throughout', 'signed_out_before_sync'] },
  clip_sync_retry: { fault: ['offline', 'http500', 'expired_token'] },
  clip_sync_edits: { edit: ['outcome', 'delete_shot', 'delete_session'] },
  clip_sync_kill_sweep: { await_points: ['odd', 'even'] },
  clip_sync_responsive: { stall: ['upload_put', 'api_delay', 'slow_auth'] },
};
const laptopMode = (v: string): FaultMode => (v === 'on' ? { kind: 'pass' } : { kind: 'down' });

async function ensureLatest(w: World, ph: Phone) {
  w.proxy.mode = { kind: 'pass' };
  const r = await ph.backend.demos.openDemo({ shotType: SHOT });
  assert(r.status === 'ready' && !r.fallback, `setup: expected ready demo, got ${json(r)}`);
  assert(r.demo.version === w.laptop.latest.version, `setup: expected v${w.laptop.latest.version}, got v${r.demo.version}`);
  return r.demo;
}

async function expectFallbackToPrevious(w: World, ph: Phone, prevVersion: number, codes: string[]) {
  const r = await ph.backend.demos.openDemo({ shotType: SHOT });
  assert(r.status === 'ready', `expected last working model, got ${json(r)}`);
  assert(r.source === 'local', 'expected local source');
  assert(r.demo.version === prevVersion, `expected kept v${prevVersion}, got v${r.demo.version}`);
  assert(r.fallback && codes.includes(r.fallback.code), `expected fallback ${codes}, got ${json(r.fallback)}`);
  assert((await ph.fileSha(r.demo.uri)) === w.laptop.versions.get(prevVersion)!.sha, 'kept model bytes changed');
}

async function expectReadyVersion(w: World, ph: Phone, r: OpenDemoResult, version: number, source: 'local' | 'downloaded', what: string) {
  assert(r.status === 'ready' && r.source === source && !r.fallback && r.demo.version === version, `${what}: expected ${source} v${version}, got ${json(r)}`);
  assert((await ph.fileSha(r.demo.uri)) === w.laptop.versions.get(version)!.sha, `${what}: bytes differ from the laptop export of v${version}`);
  assert(r.demo.cue === cueFor(version), `${what}: cue ${json(r.demo.cue)} is not v${version}'s`);
}

/**
 * Starts openDemo with the proxy holding the media body part-way, and returns
 * once bytes are arriving, so the download is provably in flight.
 */
async function startHeldDownload(w: World, ph: Phone, fraction: number) {
  const hold = deferred();
  const firstBytes = deferred();
  const progress: number[] = [];
  w.proxy.mode = { kind: 'stall_media', fraction, until: hold.promise };
  const result = ph.backend.demos.openDemo({
    shotType: SHOT,
    onProgress: (p) => {
      progress.push(p.bytesWritten);
      firstBytes.resolve();
    },
  });
  const early = await Promise.race([firstBytes.promise.then(() => null), result]);
  w.proxy.mode = { kind: 'pass' }; // the held request keeps its mode
  if (early) {
    hold.resolve();
    throw new AssertionFailed(`expected a download in flight, but openDemo settled first: ${json(early)}`);
  }
  return { result, progress, release: hold.resolve };
}

let resolveSeq = 0;
/** Records whether a ready result's model file is on disk, intact, at the moment the call resolves, and in what order calls resolved. */
function checkedAtResolve(p: Promise<OpenDemoResult>) {
  return p.then((r) => {
    const seq = ++resolveSeq;
    let intact = false;
    if (r.status === 'ready') {
      const path = fileURLToPath(r.demo.uri);
      intact = existsSync(path) && statSync(path).size === r.demo.sizeBytes;
    }
    return { r, intact, seq };
  });
}

async function expectRejects(p: Promise<unknown>, code: string, what: string) {
  const out = await p.then(
    (v) => ({ ok: true as const, v }),
    (err) => ({ ok: false as const, err }),
  );
  assert(!out.ok, `${what}: expected ${code}, but it resolved ${json(out.ok && out.v)}`);
  assert(out.err instanceof BackendError && out.err.code === code, `${what}: expected BackendError ${code}, got ${(out.err as Error)?.name}: ${(out.err as Error)?.message}`);
}

async function leftoverTemps(ph: Phone) {
  const parts = await readdir(ph.path('Caches', 'perspective-downloads')).catch(() => []);
  const staged = await readdir(ph.path('tmp')).catch(() => []);
  return [...parts, ...staged.map((f) => `tmp/${f}`)];
}

/** What SQLite had committed for a session at the moment the app died (read on a second connection). */
function durableSession(ph: Phone, id: string) {
  const db = new DatabaseSync(ph.path('perspective.db'));
  try {
    const row = db.prepare('SELECT video_path FROM sessions WHERE id = ?').get(id) as { video_path: string | null } | undefined;
    return row ? { exists: true, videoPath: row.video_path } : { exists: false, videoPath: null };
  } finally {
    db.close();
  }
}

/** Sessions whose video file holds exactly these bytes. */
async function sessionsHoldingBytes(ph: Phone, digest: string) {
  const out: string[] = [];
  for (const s of await ph.backend.sessions.listWithStats()) {
    if (!s.videoPath) continue;
    const file = ph.path('Documents', ...s.videoPath.split('/'));
    if ((await fileSize(file)) !== null && sha(await readFile(file)) === digest) out.push(s.id);
  }
  return out;
}

/** The schema the first release shipped (user_version 1), for upgrade tests. */
const V1_SCHEMA = `
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY NOT NULL,
    created_at  INTEGER NOT NULL,
    shot_type   TEXT NOT NULL,
    video_path  TEXT,
    duration_ms INTEGER,
    size_bytes  INTEGER
  );
  CREATE INDEX sessions_created_at ON sessions (created_at DESC);

  CREATE TABLE shots (
    session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    shot_number INTEGER NOT NULL,
    release_ms  INTEGER NOT NULL,
    outcome     TEXT NOT NULL DEFAULT 'unmarked' CHECK (outcome IN ('made', 'missed', 'unmarked')),
    PRIMARY KEY (session_id, shot_number)
  );

  CREATE TABLE downloaded_demos (
    demo_id       TEXT NOT NULL,
    version       INTEGER NOT NULL,
    format        TEXT NOT NULL,
    shot_type     TEXT NOT NULL,
    local_path    TEXT NOT NULL,
    cue           TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    downloaded_at INTEGER NOT NULL,
    PRIMARY KEY (demo_id, version, format)
  );
  `;

interface V1Session {
  id: string;
  shots: { n: number; outcome: Outcome }[];
  video: string | null;
}

/**
 * A phone still on the v1 database: sessions with gapped shot numbers
 * (earlier shots deleted), one without shots, one whose video was removed.
 */
async function buildV1Phone(w: World) {
  const ph = w.unlaunched();
  await mkdir(ph.path('Documents', 'videos'), { recursive: true });
  await mkdir(ph.path('Documents', 'models'), { recursive: true });
  const db = new DatabaseSync(ph.path('perspective.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V1_SCHEMA);
  db.exec('PRAGMA user_version = 1');
  const layouts = [[1, 2, 5, 9], [], [3], [2, 4, 7]];
  const sessions: V1Session[] = [];
  layouts.forEach((numbers, i) => {
    const id = randomUUID();
    const removed = i === 3;
    const video = removed ? null : `videos/${id}.mov`;
    const bytes = randomBytes(randInt(2_000, 9_000));
    if (video) writeFileSync(ph.path('Documents', 'videos', `${id}.mov`), bytes);
    db.prepare('INSERT INTO sessions (id, created_at, shot_type, video_path, duration_ms, size_bytes) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, 1_700_000_000_000 + i, SHOT, video, 12_000, video ? bytes.length : null,
    );
    const shots = numbers.map((n) => ({ n, outcome: pick(OUTCOMES) }));
    for (const x of shots) db.prepare('INSERT INTO shots (session_id, shot_number, release_ms, outcome) VALUES (?, ?, ?, ?)').run(id, x.n, x.n * 500, x.outcome);
    sessions.push({ id, shots, video });
  });
  db.close();
  return { ph, sessions };
}

/** After the upgrade: schema current, every shot kept, numbering continues after the highest old number. */
async function checkUpgraded(ph: Phone, laptop: Laptop, sessions: V1Session[]) {
  const v = await ph.platform.db.first<{ user_version: number }>('PRAGMA user_version');
  assert(Number(v?.user_version) === SCHEMA_VERSION, `user_version ${v?.user_version}, expected ${SCHEMA_VERSION}`);
  await checkInvariants(ph, laptop);
  for (const s of sessions) {
    const list = await ph.backend.shots.list(s.id);
    assert(json(list.map((x) => [x.shotNumber, x.outcome])) === json(s.shots.map((x) => [x.n, x.outcome])), `session ${s.id}: shots changed by the upgrade: ${json(list)}`);
    const replay = await ph.backend.sessions.replaySource(s.id);
    assert(replay.state === (s.video ? 'available' : 'unavailable'), `session ${s.id}: replay ${json(replay)}`);
    const want = Math.max(0, ...s.shots.map((x) => x.n)) + 1;
    const next = await ph.backend.shots.addShot(s.id, 29_000, 'made').catch((err: Error) => {
      throw new AssertionFailed(`session ${s.id} with shots ${s.shots.map((x) => x.n)}: adding a shot after the upgrade failed (expected #${want}): ${err.message}`);
    });
    assert(next.shotNumber === want, `session ${s.id} with shots ${s.shots.map((x) => x.n)}: next shot got #${next.shotNumber}, expected #${want}`);
    s.shots.push({ n: next.shotNumber, outcome: 'made' });
  }
}

// ---------- cloud helpers ----------
const clipStates = async (ph: Phone, sessionId: string) =>
  new Map(
    (await ph.platform.db.all<{ shot_number: number; clip_state: string; outcome: string; release_ms: number }>(
      'SELECT shot_number, clip_state, outcome, release_ms FROM shots WHERE session_id = ? ORDER BY shot_number',
      [sessionId],
    )).map((r) => [Number(r.shot_number), r] as const),
  );
const serverRows = (sessionId: string) => CLOUD.deps.clips.rows().filter((r) => r.sessionId === sessionId);
const queuedDeletes = async (ph: Phone) => Number((await ph.platform.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM clip_deletes'))?.n);

/** Records which user owns each of the phone's sessions, for the cloud invariants. Call before a sync. */
async function register(ph: Phone) {
  const user = ph.user;
  if (!user) return;
  for (const r of await ph.platform.db.all<{ id: string }>('SELECT id FROM sessions')) {
    if (!CLOUD.sessions.has(r.id)) CLOUD.sessions.set(r.id, { phone: ph, user });
  }
}

async function sync(ph: Phone) {
  await register(ph);
  return ph.backend.clips.syncNow();
}

/** A signed-in phone with a recorded session and tagged shots (outcomes kept for later checks). */
async function taggedSession(ph: Phone, releases: number[], want?: (v: PoolVideo) => boolean) {
  const s = await ph.recordSession(undefined, want);
  const shots = new Map<number, { releaseMs: number; outcome: Outcome }>();
  for (const r of releases) {
    const outcome = pick(OUTCOMES);
    const shot = await ph.backend.shots.addShot(s.id, r, outcome);
    shots.set(shot.shotNumber, { releaseMs: r, outcome });
  }
  return { s, shots };
}
const someReleases = (durationMs: number, n: number) => Array.from({ length: n }, () => randInt(0, durationMs));

/** The server holds exactly these shots of the session, under this user, with these outcomes. */
function expectServer(sessionId: string, user: string, want: Map<number, Outcome>, what: string) {
  const rows = serverRows(sessionId).sort((a, b) => a.shotNumber - b.shotNumber);
  const wantNums = [...want.keys()].sort((a, b) => a - b);
  assert(json(rows.map((r) => r.shotNumber)) === json(wantNums), `${what}: server clips ${json(rows.map((r) => r.shotNumber))}, expected ${json(wantNums)}`);
  for (const r of rows) {
    assert(r.userId === user, `${what}: clip #${r.shotNumber} stored under ${r.userId}`);
    assert(r.outcome === want.get(r.shotNumber), `${what}: clip #${r.shotNumber} outcome ${r.outcome}, expected ${want.get(r.shotNumber)}`);
  }
}

async function expectStates(ph: Phone, sessionId: string, want: string | ((n: number) => string), what: string) {
  for (const [n, r] of await clipStates(ph, sessionId)) {
    const w = typeof want === 'string' ? want : want(n);
    assert(r.clip_state === w, `${what}: shot #${n} is ${r.clip_state}, expected ${w}`);
  }
}

async function noRecordingLeft(sessionId: string, what: string) {
  const left = (await blobFiles('recordings')).filter((p) => p.includes(`/${sessionId}/`));
  assert(left.length === 0, `${what}: the full recording is still in blob storage: ${left}`);
}

const outcomesOf = (shots: Map<number, { outcome: Outcome }>) => new Map([...shots].map(([n, x]) => [n, x.outcome]));

/** A sync that must fully succeed: no errors, nothing left waiting, no queued deletes. */
async function syncOk(ph: Phone, what: string) {
  const report = await sync(ph);
  assert(report.errors.length === 0 && report.pending === 0, `${what}: sync did not finish cleanly: ${json(report)}`);
  assert((await queuedDeletes(ph)) === 0, `${what}: clip_deletes not empty after a successful sync`);
  return report;
}

async function blobFiles(prefix: 'clips' | 'recordings'): Promise<string[]> {
  const root = CLOUD.deps.blob.fileOf(`${prefix}/`);
  const names = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names) if ((await fileSize(join(root, n))) !== null && !n.endsWith('.part')) out.push(`${prefix}/${n}`);
  return out;
}

/**
 * The server's clip set matches the phones: every row belongs to a session a
 * phone synced as that row's user, and for each session of a touched phone,
 * the server holds exactly its synced and outcome_dirty shots (a shot mid-cut
 * may go either way; a shot or session whose remote delete is still queued
 * may linger), with the phone's outcome for synced shots. Every clip blob has
 * a row and every row its blob.
 */
async function checkCloudInvariants(phones: Iterable<Phone>) {
  const rows = CLOUD.deps.clips.rows();
  const blobs = new Set(await blobFiles('clips'));
  for (const r of rows) {
    const reg = CLOUD.sessions.get(r.sessionId);
    assert(reg, `server holds clip ${r.sessionId}#${r.shotNumber} for a session no signed-in phone synced`);
    assert(r.userId === reg.user, `clip ${r.sessionId}#${r.shotNumber} is stored under user ${r.userId}, but ${reg.user} synced it`);
    assert(blobs.has(r.clipPathname), `clip row ${r.clipPathname} has no blob`);
    blobs.delete(r.clipPathname);
  }
  assert(blobs.size === 0, `clip blobs without a row: ${[...blobs].slice(0, 5)}`);

  for (const ph of phones) {
    const mine = [...CLOUD.sessions].filter(([, v]) => v.phone === ph).map(([id]) => id);
    if (!mine.length) continue;
    const db = new DatabaseSync(ph.path('perspective.db'));
    try {
      for (const sid of mine) {
        const local = new Map(
          (db.prepare('SELECT shot_number, clip_state, outcome FROM shots WHERE session_id = ?').all(sid) as { shot_number: number; clip_state: string; outcome: string }[]).map((r) => [Number(r.shot_number), r]),
        );
        const queued = new Set((db.prepare('SELECT shot_number FROM clip_deletes WHERE session_id = ?').all(sid) as { shot_number: number }[]).map((r) => Number(r.shot_number)));
        const remote = new Map(rows.filter((r) => r.sessionId === sid).map((r) => [r.shotNumber, r]));
        for (const [n, l] of local) {
          const r = remote.get(n);
          if (l.clip_state === 'synced' || l.clip_state === 'outcome_dirty') {
            assert(r, `${ph.name}: shot ${sid}#${n} is ${l.clip_state} but the server has no clip`);
            if (l.clip_state === 'synced') assert(r.outcome === l.outcome, `${ph.name}: shot ${sid}#${n} is synced as ${l.outcome}, server says ${r.outcome}`);
          } else if (l.clip_state !== 'cutting') {
            assert(!r, `${ph.name}: shot ${sid}#${n} is ${l.clip_state} but the server holds a clip for it`);
          }
        }
        for (const n of remote.keys()) {
          assert(local.has(n) || queued.has(n) || queued.has(0), `${ph.name}: server keeps clip ${sid}#${n} after the phone deleted it, and no remote delete is queued`);
        }
      }
    } finally {
      db.close();
    }
  }
}

type Scenario = (w: World) => Promise<void>;

const SCENARIOS: Record<string, Scenario> = {
  async fresh_install_download(w) {
    const ph = await w.fresh();
    const h = await ph.backend.api.health();
    assert(h.ok, `health failed: ${h.error}`);
    const progress: number[] = [];
    const r = await ph.backend.demos.openDemo({ shotType: SHOT, onProgress: (p) => progress.push(p.bytesWritten) });
    assert(r.status === 'ready' && r.source === 'downloaded', `expected download, got ${json(r)}`);
    assert(r.demo.version === w.laptop.latest.version, 'wrong version');
    assert((await ph.fileSha(r.demo.uri)) === w.laptop.latest.sha, 'downloaded bytes differ from laptop export');
    assert(r.demo.cue.includes('Hold your finish'), 'cue missing');
    assert(progress.length > 0 && progress.at(-1) === w.laptop.latest.size, 'progress did not reach total');
  },

  async relaunch_offline_reopen(w) {
    const ph = pick(w.pool);
    const demo = await ensureLatest(w, ph);
    w.proxy.mode = { kind: 'down' };
    await ph.relaunch();
    const h = await ph.backend.api.health();
    assert(!h.ok, 'health should fail while laptop is off');
    const r = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'ready' && r.source === 'local', `offline reopen failed: ${json(r)}`);
    assert(r.fallback?.code === 'unreachable', `expected unreachable, got ${r.fallback?.code}`);
    assert(r.demo.version === demo.version && r.demo.cue === demo.cue, 'offline demo/cue mismatch');
    assert((await ph.fileSha(r.demo.uri)) === w.laptop.versions.get(demo.version)!.sha, 'offline bytes corrupted');
  },

  async relaunch_online_cached(w) {
    const ph = pick(w.pool);
    await ensureLatest(w, ph);
    await ph.relaunch();
    const before = w.proxy.counters.mediaRequests;
    const r = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'ready' && r.source === 'local' && !r.fallback, `expected cached open, got ${json(r)}`);
    assert(w.proxy.counters.mediaRequests === before, 'should not re-download an up-to-date model');
  },

  async version_upgrade(w) {
    const ph = pick(w.pool);
    const old = await ensureLatest(w, ph);
    const pub = await w.laptop.publish();
    const r = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'ready' && r.source === 'downloaded' && r.demo.version === pub.version, `upgrade failed: ${json(r)}`);
    assert((await ph.fileSha(r.demo.uri)) === pub.sha, 'upgraded bytes differ');
    const models = await readdir(ph.path('Documents', 'models'));
    assert(models.length === 1 && !models.some((m) => m.includes(`-v${old.version}.`)), `old version not pruned: ${models}`);
  },

  async truncated_download_keeps_last(w) {
    const ph = pick(w.pool);
    const old = await ensureLatest(w, ph);
    const pub = await w.laptop.publish();
    w.proxy.mode = { kind: 'truncate_media', fraction: 0.1 + rng() * 0.8 };
    await expectFallbackToPrevious(w, ph, old.version, ['download_failed', 'size_mismatch']);
    w.proxy.mode = { kind: 'pass' };
    const r = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'ready' && r.demo.version === pub.version, 'retry after truncation failed');
  },

  async size_mismatch_catalog(w) {
    const ph = pick(w.pool);
    const old = await ensureLatest(w, ph);
    await w.laptop.publish({ wrongSize: true });
    await expectFallbackToPrevious(w, ph, old.version, ['size_mismatch']);
    await w.laptop.reset();
    const r = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'ready' && r.source === 'downloaded' && r.demo.version === w.laptop.latest.version, 'repair not picked up');
  },

  async unreachable_no_model(w) {
    const ph = await w.fresh();
    w.proxy.mode = { kind: 'down' };
    const r = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'unavailable' && r.canRetry && r.code === 'unreachable', `expected retry state, got ${json(r)}`);
    w.proxy.mode = { kind: 'pass' };
    const again = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(again.status === 'ready' && again.source === 'downloaded', 'retry did not download');
  },

  async asset_404(w) {
    const ph = pick(w.pool);
    const old = await ensureLatest(w, ph);
    await w.laptop.publish({ missingFile: true });
    await expectFallbackToPrevious(w, ph, old.version, ['http_error']);
    await w.laptop.reset();
    await ensureLatest(w, ph);
  },

  async slow_network_timeout(w) {
    const ph = pick(w.pool);
    const old = await ensureLatest(w, ph);
    w.proxy.mode = { kind: 'delay', ms: CATALOG_TIMEOUT_MS * 2 };
    await expectFallbackToPrevious(w, ph, old.version, ['timeout']);
    const fresh = await w.fresh();
    const r = await fresh.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'unavailable' && r.code === 'timeout', `expected timeout retry state, got ${json(r)}`);
  },

  async garbage_catalog(w) {
    const ph = pick(w.pool);
    const old = await ensureLatest(w, ph);
    w.proxy.mode = { kind: 'garbage_catalog' };
    await expectFallbackToPrevious(w, ph, old.version, ['invalid_catalog']);
  },

  async server_error_500(w) {
    const ph = pick(w.pool);
    const old = await ensureLatest(w, ph);
    w.proxy.mode = { kind: 'http500' };
    await expectFallbackToPrevious(w, ph, old.version, ['http_error']);
  },

  async low_disk(w) {
    const ph = await w.fresh();
    ph.freeBytesOverride = randInt(0, 40_000_000);
    const space = await ph.backend.sessions.checkRecordingSpace();
    assert(!space.ok, 'recording space check should fail on a full phone');
    const r = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'unavailable' && r.code === 'insufficient_space', `expected insufficient_space, got ${json(r)}`);
    ph.freeBytesOverride = undefined;
    const ok = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(ok.status === 'ready', 'download after freeing space failed');
  },

  async concurrent_taps(w) {
    const ph = await w.fresh();
    const before = w.proxy.counters.mediaRequests;
    const taps = await Promise.all(Array.from({ length: randInt(2, 5) }, () => ph.backend.demos.openDemo({ shotType: SHOT })));
    assert(taps.every((t) => t.status === 'ready' && t.demo.version === w.laptop.latest.version), 'a tap failed');
    assert(w.proxy.counters.mediaRequests - before === 1, `expected 1 download, saw ${w.proxy.counters.mediaRequests - before}`);
  },

  async record_tag_restart(w) {
    const ph = pick(w.pool);
    w.proxy.mode = laptopMode(w.branch('laptop')); // capture must not care about the laptop
    const ext = pick(['mov', 'mp4', 'MOV']);
    const clip = await ph.fakeRecording(ext);
    const s = await ph.backend.sessions.saveRecording({ tempUri: clip.uri, durationMs: randInt(1_000, 35_000) });
    assert(s.videoPath?.endsWith(`.${ext.toLowerCase()}`), `extension not kept: ${s.videoPath}`);
    assert(s.durationMs! <= 30_000, 'duration not capped at 30s');
    assert(!(await ph.platform.files.info(clip.uri)).exists, 'clip still in camera cache');

    const counts = { made: 0, missed: 0, unmarked: 0 };
    const n = randInt(0, 12);
    const outcomes: Outcome[] = [];
    for (let i = 0; i < n; i++) {
      const shot = await ph.backend.shots.addShot(s.id, randInt(0, s.durationMs!));
      assert(shot.shotNumber === i + 1, 'shot numbering not sequential');
      const o = pick(OUTCOMES);
      if (o !== 'unmarked') await ph.backend.shots.setOutcome(s.id, shot.shotNumber, o);
      outcomes.push(o);
    }
    for (let k = 0; k < randInt(0, 4) && n > 0; k++) {
      const idx = randInt(0, n - 1);
      const o = pick(OUTCOMES);
      await ph.backend.shots.setOutcome(s.id, idx + 1, o);
      outcomes[idx] = o;
    }
    for (const o of outcomes) counts[o]++;

    await ph.relaunch();
    const st = await ph.backend.shots.stats(s.id);
    const attempts = counts.made + counts.missed;
    assert(st.made === counts.made && st.missed === counts.missed && st.unmarked === counts.unmarked, `stats mismatch ${json(st)} vs ${json(counts)}`);
    assert(attempts === 0 ? st.percentage === null : Math.abs(st.percentage! - counts.made / attempts) < 1e-9, 'percentage wrong');
    const listed = (await ph.backend.sessions.listWithStats()).find((x) => x.id === s.id);
    assert(listed && listed.stats.made === counts.made && listed.stats.unmarked === counts.unmarked, 'saved clips list missing/incorrect');
    const replay = await ph.backend.sessions.replaySource(s.id);
    assert(replay.state === 'available', 'replay unavailable after relaunch');
  },

  async remove_video_keeps_stats(w) {
    const ph = pick(w.pool);
    const clip = await ph.fakeRecording('mov');
    const s = await ph.backend.sessions.saveRecording({ tempUri: clip.uri, durationMs: 12_000 });
    await ph.backend.shots.addShot(s.id, 1000, 'made');
    await ph.backend.shots.addShot(s.id, 4000, 'missed');
    await ph.backend.shots.addShot(s.id, 8000);
    const { reclaimedBytes } = await ph.backend.sessions.removeVideo(s.id);
    assert(reclaimedBytes === s.sizeBytes, 'reclaimed bytes mismatch');
    await ph.relaunch();
    const replay = await ph.backend.sessions.replaySource(s.id);
    assert(replay.state === 'unavailable' && replay.reason === 'removed', 'expected unavailable replay');
    const st = await ph.backend.shots.stats(s.id);
    assert(st.made === 1 && st.missed === 1 && st.unmarked === 1 && st.percentage === 0.5, `stats lost: ${json(st)}`);
  },

  async crash_recovery(w) {
    const ph = pick(w.pool);
    const demo = await ensureLatest(w, ph);
    await mkdir(ph.path('Caches', 'perspective-downloads'), { recursive: true });
    await writeFile(ph.path('Caches', 'perspective-downloads', 'x-v9.usdz.abc.part'), randomBytes(100));
    await writeFile(ph.path('Documents', 'models', 'orphan-v1.usdz'), randomBytes(100));
    await writeFile(ph.path('Documents', 'videos', 'orphan.mov'), randomBytes(100));
    w.proxy.mode = { kind: 'down' };
    const rec = await ph.relaunch();
    assert(rec.partialDownloadsRemoved >= 1 && rec.orphanModelsRemoved >= 1 && rec.orphanVideosRemoved >= 1, `recovery incomplete ${json(rec)}`);
    const r = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'ready' && r.demo.version === demo.version, 'real model lost during recovery');
  },

  async api_contract(w) {
    const ph = pick(w.pool);
    w.proxy.mode = { kind: 'pass' };
    assert((await ph.backend.api.health()).ok, 'health');
    const list = await ph.backend.api.listDemos(SHOT);
    assert(list.length === 1 && list[0]!.shotType === SHOT, 'shotType filter');
    assert((await ph.backend.api.listDemos('golf_swing')).length === 0, 'unknown shotType should be empty');
    const base = 'http://192.168.1.5:3001';
    assert(resolveAssetUrl(base, '/media/a-v1.usdz') === `${base}/media/a-v1.usdz`, 'relative url');
    assert(resolveAssetUrl(base, 'https://cdn.example.com/a.usdz') === 'https://cdn.example.com/a.usdz', 'https passthrough');
    let threw = false;
    try {
      resolveAssetUrl(base, 'http://evil.example.com/a.usdz');
    } catch {
      threw = true;
    }
    assert(threw, 'foreign http url must be rejected');
  },

  /** Many quick taps on "tag shot": every call succeeds with its own number, 1..n, no gaps. */
  async rapid_tagging(w) {
    const ph = await w.fresh(); // a broken connection must not leak into the pool phones
    w.proxy.mode = laptopMode(w.branch('laptop'));
    const s = await ph.recordSession(30_000);
    const n = randInt(5, 20);
    const want = Array.from({ length: n }, (_, i) => ({ releaseMs: i * 1_400 + randInt(0, 999), outcome: pick(OUTCOMES) }));
    const bogus = `no-such-session-${randomUUID()}`;
    // The unknown-session tap lands mid-burst; it must fail alone.
    const calls = want.map((x) => ph.backend.shots.addShot(s.id, x.releaseMs, x.outcome));
    calls.splice(randInt(0, n), 0, ph.backend.shots.addShot(bogus, 100, 'made'));
    const settled = await Promise.allSettled(calls);
    const results = settled.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<Awaited<(typeof calls)[number]>>).value);
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert(
      rejected.length === 1 && rejected[0]!.reason instanceof BackendError && rejected[0]!.reason.code === 'not_found',
      `expected exactly the unknown-session tap to fail with not_found; ${rejected.length} of ${n + 1} rejected: ${rejected.map((r) => (r.reason as Error)?.message).join(' | ')}`,
    );
    assert(results.every((r) => r.sessionId === s.id), 'a tap was recorded against the wrong session');
    const numbers = results.map((r) => r.shotNumber).sort((a, b) => a - b);
    assert(numbers.length === n && numbers.every((v, i) => v === i + 1), `shot numbers not unique and gap-free 1..${n}: ${numbers}`);

    // Concurrent re-tags of distinct shots: each is one UPDATE.
    const finalOutcome = new Map(results.map((r) => [r.shotNumber, r.outcome] as const));
    const retag = [...finalOutcome.keys()].filter(() => rng() < 0.5).map((k) => [k, pick(OUTCOMES)] as const);
    const edits = await Promise.allSettled(retag.map(([k, o]) => ph.backend.shots.setOutcome(s.id, k, o)));
    assert(edits.every((e) => e.status === 'fulfilled'), `concurrent re-tag failed: ${json(edits.filter((e) => e.status === 'rejected'))}`);
    for (const [k, o] of retag) finalOutcome.set(k, o);

    await ph.relaunch();
    const rows = await ph.backend.shots.list(s.id);
    assert(rows.length === n && rows.every((r, i) => r.shotNumber === i + 1), `stored shot numbers ${rows.map((r) => r.shotNumber)}`);
    for (const r of results) {
      const row = rows.find((x) => x.shotNumber === r.shotNumber)!;
      const src = want.find((x) => x.releaseMs === r.releaseMs);
      assert(src && row.releaseMs === r.releaseMs, `shot #${r.shotNumber} was returned for release ${r.releaseMs} ms but stores ${row.releaseMs} ms`);
      assert(row.outcome === finalOutcome.get(r.shotNumber), `shot #${r.shotNumber} outcome ${row.outcome}, expected ${finalOutcome.get(r.shotNumber)}`);
    }
    const counts = { made: 0, missed: 0, unmarked: 0 };
    for (const o of finalOutcome.values()) counts[o]++;
    const st = await ph.backend.shots.stats(s.id);
    const attempts = counts.made + counts.missed;
    assert(st.made === counts.made && st.missed === counts.missed && st.unmarked === counts.unmarked, `stats ${json(st)} vs ${json(counts)}`);
    assert(attempts === 0 ? st.percentage === null : Math.abs(st.percentage! - counts.made / attempts) < 1e-9, 'percentage wrong');
  },

  /** The laptop lists nothing for the drill: a new phone gets a retry state, a phone with a model still opens it. */
  async catalog_no_entry(w) {
    const ph = pick(w.pool);
    const saved = await ensureLatest(w, ph);
    await w.laptop.setCatalog({ dropDrill: true });
    assert((await ph.backend.api.listDemos(SHOT)).length === 0, 'catalog should have no entry for the drill');
    const before = w.proxy.counters.mediaRequests;

    const fresh = await w.fresh();
    const r = await fresh.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'unavailable' && r.code === 'not_found' && r.canRetry, `fresh phone: expected not_found retry state, got ${json(r)}`);

    const kept = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(kept.status === 'ready' && kept.source === 'local' && kept.demo.version === saved.version, `saved model did not open: ${json(kept)}`);
    assert((await ph.fileSha(kept.demo.uri)) === w.laptop.versions.get(saved.version)!.sha, 'saved model bytes changed');
    assert(w.proxy.counters.mediaRequests === before, 'nothing should be downloaded while the drill is unlisted');

    // The entry comes back: the retry downloads.
    await w.laptop.reset();
    const again = await fresh.backend.demos.openDemo({ shotType: SHOT });
    await expectReadyVersion(w, fresh, again, w.laptop.latest.version, 'downloaded', 'retry after the drill was re-listed');
  },

  /** openDemo({ version }) gets exactly that version, reopens it locally, and an unpinned open upgrades again. */
  async pinned_version(w) {
    while (w.laptop.latest.version < 2) await w.laptop.publish();
    await w.laptop.setCatalog({ allVersions: true });
    const latest = w.laptop.latest.version;
    const old = randInt(Math.max(1, latest - 4), latest - 1);
    const ph = await w.fresh();

    const r = await ph.backend.demos.openDemo({ shotType: SHOT, version: old });
    await expectReadyVersion(w, ph, r, old, 'downloaded', `pinned v${old} on a new phone`);

    const before = w.proxy.counters.mediaRequests;
    const again = await ph.backend.demos.openDemo({ shotType: SHOT, version: old });
    await expectReadyVersion(w, ph, again, old, 'local', `pinned v${old} reopened`);
    assert(w.proxy.counters.mediaRequests === before, 'pinned reopen re-downloaded');

    const up = await ph.backend.demos.openDemo({ shotType: SHOT });
    await expectReadyVersion(w, ph, up, latest, 'downloaded', 'unpinned open after a pin');

    const back = await ph.backend.demos.openDemo({ shotType: SHOT, version: old });
    await expectReadyVersion(w, ph, back, old, 'downloaded', `pinned v${old} while v${latest} is saved`);

    const missing = latest + 100;
    const nf = await ph.backend.demos.openDemo({ shotType: SHOT, version: missing });
    assert(nf.status === 'ready' && nf.source === 'local' && nf.demo.version === old && nf.fallback?.code === 'not_found', `unlisted pin should keep v${old} with not_found, got ${json(nf)}`);
    const other = await w.fresh();
    const nf2 = await other.backend.demos.openDemo({ shotType: SHOT, version: missing });
    assert(nf2.status === 'unavailable' && nf2.code === 'not_found', `unlisted pin on a new phone: expected not_found, got ${json(nf2)}`);
  },

  /** The catalog points at http://<laptop>/media/... (the API's own origin): accepted and downloaded. */
  async same_origin_http_url(w) {
    const upgrade = w.branch('phone') === 'upgrade';
    const ph = upgrade ? pick(w.pool) : await w.fresh();
    if (upgrade) {
      await ensureLatest(w, ph);
      await w.laptop.publish();
    }
    w.proxy.mode = { kind: 'absolute_http_catalog' };
    const list = await ph.backend.api.listDemos(SHOT);
    const url = list[0]?.assets[0]?.url ?? '';
    assert(url === `${w.proxy.url}/media/${DEMO_ID}-v${w.laptop.latest.version}.usdz`, `catalog should carry an absolute same-origin http URL, got ${url}`);
    const before = w.proxy.counters.mediaRequests;
    const r = await ph.backend.demos.openDemo({ shotType: SHOT });
    await expectReadyVersion(w, ph, r, w.laptop.latest.version, 'downloaded', 'absolute same-origin http asset');
    assert(w.proxy.counters.mediaRequests - before === 1, 'the absolute URL was not fetched through the API origin');
  },

  /** Deleting a session removes its row, its shots and its video, and nothing else. */
  async delete_session(w) {
    const ph = pick(w.pool);
    w.proxy.mode = laptopMode(w.branch('laptop'));
    const keep = await ph.recordSession();
    await ph.backend.shots.addShot(keep.id, 500, 'made');
    await ph.backend.shots.addShot(keep.id, 900, 'missed');
    const keepStats = await ph.backend.shots.stats(keep.id);

    const s = await ph.recordSession();
    for (let i = 0; i < randInt(1, 8); i++) await ph.backend.shots.addShot(s.id, i * 1_000, pick(OUTCOMES));
    const videoRemovedFirst = w.branch('video') === 'removed_first';
    if (videoRemovedFirst) await ph.backend.sessions.removeVideo(s.id);
    const videoFile = ph.path('Documents', ...s.videoPath!.split('/'));

    const expectGone = async (when: string) => {
      assert((await ph.backend.sessions.get(s.id)) === null, `${when}: session row still there`);
      const n = await ph.platform.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM shots WHERE session_id = ?', [s.id]);
      assert(Number(n?.n) === 0, `${when}: ${n?.n} shots rows outlived their session`);
      assert((await ph.backend.shots.list(s.id)).length === 0, `${when}: shots still listed`);
      assert((await fileSize(videoFile)) === null, `${when}: video file still on disk`);
      assert(!(await ph.backend.sessions.listWithStats()).some((x) => x.id === s.id), `${when}: still in Saved Clips`);
      const replay = await ph.backend.sessions.replaySource(s.id).then(
        (x) => x,
        (err) => err,
      );
      assert(replay instanceof BackendError && replay.code === 'not_found', `${when}: replay of a deleted session gave ${json(replay)}`);
    };

    await ph.backend.sessions.deleteSession(s.id);
    await expectGone('after delete');
    await ph.relaunch();
    await expectGone('after relaunch');
    await ph.backend.sessions.deleteSession(s.id); // second delete is a no-op

    const st = await ph.backend.shots.stats(keep.id);
    assert(json(st) === json(keepStats), `another session's stats changed: ${json(st)} vs ${json(keepStats)}`);
    assert((await ph.backend.sessions.replaySource(keep.id)).state === 'available', "another session's video went missing");
  },

  /** Record and tag while a model download is in flight; both finish correctly. */
  async record_during_download(w) {
    const ph = pick(w.pool);
    await ensureLatest(w, ph);
    const pub = await w.laptop.publish();
    const dl = await startHeldDownload(w, ph, 0.1 + rng() * 0.8);
    let session;
    const outcomes: Outcome[] = [];
    try {
      session = await ph.recordSession();
      const n = randInt(2, 10);
      const releaseAt = randInt(0, n); // the download finishes while tagging continues
      for (let i = 0; i < n; i++) {
        if (i === releaseAt) dl.release();
        const o = pick(OUTCOMES);
        const shot = await ph.backend.shots.addShot(session.id, i * 2_000, o);
        assert(shot.shotNumber === i + 1, `shot numbering broke during the download: got #${shot.shotNumber}, expected #${i + 1}`);
        outcomes.push(o);
      }
    } finally {
      dl.release();
      await dl.result.catch(() => undefined);
    }
    const r = await dl.result;
    await expectReadyVersion(w, ph, r, pub.version, 'downloaded', 'download overlapping a recording');
    assert(dl.progress.at(-1) === pub.size, `progress ended at ${dl.progress.at(-1)} of ${pub.size}`);

    await ph.relaunch();
    const st = await ph.backend.shots.stats(session.id);
    const want = { made: 0, missed: 0, unmarked: 0 };
    for (const o of outcomes) want[o]++;
    assert(st.made === want.made && st.missed === want.missed && st.unmarked === want.unmarked, `stats ${json(st)} vs ${json(want)}`);
    assert((await ph.backend.sessions.replaySource(session.id)).state === 'available', 'recording lost during the download');
    const after = await ph.backend.demos.openDemo({ shotType: SHOT });
    await expectReadyVersion(w, ph, after, pub.version, 'local', 'model after relaunch');
  },

  /** iOS kills the app mid-download. The relaunch cleans up and keeps the last model; the next open works. */
  async kill_mid_download(w) {
    const upgrade = w.branch('phone') === 'upgrade';
    const ph = upgrade ? pick(w.pool) : await w.fresh();
    const prev = upgrade ? await ensureLatest(w, ph) : null;
    const pub = upgrade ? await w.laptop.publish() : w.laptop.latest;

    const dl = await startHeldDownload(w, ph, 0.05 + rng() * 0.9);
    ph.kill();
    dl.release(); // the dead app already hung up; its openDemo never settles

    // Leftovers a kill at a neighbouring await point leaves: a finished .part
    // (after downloadAsync resolved, before the move) and the new model in
    // models/ with no row (after the move, before the INSERT).
    const bytes = await readFile(w.laptop.file(pub.version));
    await mkdir(ph.path('Caches', 'perspective-downloads'), { recursive: true });
    await writeFile(ph.path('Caches', 'perspective-downloads', `${DEMO_ID}-v${pub.version}.usdz.${randomUUID()}.part`), bytes.subarray(0, randInt(1, bytes.length)));
    await writeFile(ph.path('Documents', 'models', `${DEMO_ID}-v${pub.version}.usdz`), bytes);

    w.proxy.mode = laptopMode(w.branch('relaunch_laptop'));
    const rec = await ph.relaunch();
    assert(rec.partialDownloadsRemoved >= 1 && rec.orphanModelsRemoved >= 1, `relaunch left kill leftovers: ${json(rec)}`);
    await checkInvariants(ph, w.laptop);

    if (prev) {
      w.proxy.mode = { kind: 'down' };
      const r = await ph.backend.demos.openDemo({ shotType: SHOT });
      assert(r.status === 'ready' && r.source === 'local' && r.demo.version === prev.version, `last working model lost to the kill: ${json(r)}`);
      assert((await ph.fileSha(r.demo.uri)) === w.laptop.versions.get(prev.version)!.sha, 'kept model bytes changed');
    }
    w.proxy.mode = { kind: 'pass' };
    const next = await ph.backend.demos.openDemo({ shotType: SHOT });
    await expectReadyVersion(w, ph, next, pub.version, 'downloaded', 'first open after the kill');
  },

  /**
   * Kills the app at every await point of a model upgrade in turn (each call
   * either lands or never starts), relaunches, and checks that disk and
   * SQLite agree and the next open works.
   */
  async kill_at_each_await_point(w) {
    while (w.laptop.latest.version < 2) await w.laptop.publish();
    await w.laptop.setCatalog({ allVersions: true });
    const target = w.laptop.latest.version;
    const prev = target - 1;
    const ph = await w.fresh();
    for (let k = 1; k < 400; k++) {
      for (const land of [false, true]) {
        const setup = await ph.backend.demos.openDemo({ shotType: SHOT, version: prev });
        await expectReadyVersion(w, ph, setup, prev, setup.status === 'ready' ? setup.source : 'downloaded', `setup before kill point ${k}`);
        const proc = ph.platform.process;
        proc.killAtCall(k, land);
        const run = ph.backend.demos.openDemo({ shotType: SHOT });
        const done = await Promise.race([run, proc.died.then(() => null)]);
        if (done) {
          // The upgrade finished before call k: every await point has been covered.
          proc.disarm();
          await expectReadyVersion(w, ph, done, target, 'downloaded', 'uninterrupted upgrade');
          assert(k > 5, `the upgrade made only ${k - 1} port calls; the kill sweep is not reaching it`);
          return;
        }
        const where = `killed at await point ${k}, ${proc.diedAt}`;
        await ph.relaunch();
        try {
          await checkInvariants(ph, w.laptop);
          const r = await ph.backend.demos.openDemo({ shotType: SHOT });
          await expectReadyVersion(w, ph, r, target, r.status === 'ready' ? r.source : 'downloaded', 'open after relaunch');
          await checkInvariants(ph, w.laptop);
        } catch (err) {
          throw new AssertionFailed(`${where}: ${(err as Error).message}`);
        }
      }
    }
    throw new AssertionFailed('kill sweep never reached the end of the upgrade');
  },

  /** The laptop sends a body bigger than the catalog's sizeBytes (correct Content-Length): stop early, keep the last model. */
  async oversize_media(w) {
    const upgrade = w.branch('phone') === 'upgrade';
    const ph = upgrade ? pick(w.pool) : await w.fresh();
    const prev = upgrade ? await ensureLatest(w, ph) : null;
    const pub = upgrade ? await w.laptop.publish() : w.laptop.latest;
    const extra = randInt(1, 4) * 1_048_576 + randInt(0, 65_535);
    // With a Content-Length the phone can refuse up front; chunked, it must stop on the bytes received.
    const chunked = w.branch('length') === 'chunked';
    w.proxy.mode = { kind: 'oversize_media', extraBytes: extra, chunked };
    const progress: number[] = [];
    const r = await ph.backend.demos.openDemo({ shotType: SHOT, onProgress: (p) => progress.push(p.bytesWritten) });
    w.proxy.mode = { kind: 'pass' };
    if (prev) {
      assert(r.status === 'ready' && r.source === 'local' && r.demo.version === prev.version && r.fallback?.code === 'size_mismatch', `expected v${prev.version} kept with size_mismatch, got ${json(r)}`);
      assert((await ph.fileSha(r.demo.uri)) === w.laptop.versions.get(prev.version)!.sha, 'kept model bytes changed');
    } else {
      assert(r.status === 'unavailable' && r.code === 'size_mismatch', `expected unavailable size_mismatch, got ${json(r)}`);
    }
    const most = Math.max(0, ...progress);
    assert(most <= pub.size + 65_536, `progress reached ${most} bytes for a ${pub.size}-byte asset (+${extra} served): ${chunked ? 'chunked' : 'with Content-Length'}: the oversize body was downloaded instead of stopped`);
    const temps = await leftoverTemps(ph);
    assert(temps.length === 0, `temp files left after the oversize download: ${temps}`);
    const ok = await ph.backend.demos.openDemo({ shotType: SHOT });
    await expectReadyVersion(w, ph, ok, pub.version, 'downloaded', 'retry with a correct body');
  },

  /** Opens that resolve to different versions overlap; each gets a model that exists when it resolves, one survives. */
  async overlapping_versions(w) {
    while (w.laptop.latest.version < 2) await w.laptop.publish();
    type Checked = Awaited<ReturnType<typeof checkedAtResolve>>;

    const finish = async (ph: Phone, label: string, results: [Checked, Checked], want: [number, number], keepVersion: number) => {
      w.touched.add(ph);
      for (let i = 0; i < 2; i++) {
        const { r, intact } = results[i]!;
        assert(r.status === 'ready' && r.demo.version === want[i], `${label}: call ${i + 1} expected ready v${want[i]}, got ${json(r)}`);
        assert(intact, `${label}: call ${i + 1} resolved v${want[i]} but its model file was gone or incomplete at that moment`);
      }
      const models = await readdir(ph.path('Documents', 'models'));
      assert(models.length === 1, `${label}: expected exactly one model after both opens, found ${models}`);
      const kept = `${DEMO_ID}-v${keepVersion}.usdz`;
      assert(models[0] === kept, `${label}: expected ${kept} to be kept, found ${models[0]}`);
      await checkInvariants(ph, w.laptop);
      w.proxy.mode = { kind: 'pass' };
      const next = await ph.backend.demos.openDemo({ shotType: SHOT });
      assert(next.status === 'ready' && next.demo.version === w.laptop.latest.version, `${label}: next open ${json(next)}`);
    };

    // Variant 1: a pinned and an unpinned open at once.
    {
      w.cover('variant', 'pinned_and_unpinned');
      const label = 'pinned + unpinned';
      await w.laptop.setCatalog({ allVersions: true });
      const ph = w.branch('pinned_phone') === 'pool' ? pick(w.pool) : await w.fresh();
      const latest = w.laptop.latest.version;
      const old = randInt(Math.max(1, latest - 3), latest - 1);
      const pinned = checkedAtResolve(ph.backend.demos.openDemo({ shotType: SHOT, version: old }));
      const unpinned = checkedAtResolve(ph.backend.demos.openDemo({ shotType: SHOT }));
      const [first, second] = await Promise.all([pinned, unpinned]);
      // A pin and an unpinned open disagree on purpose: whatever resolved last is on screen, so it is kept.
      await finish(ph, label, [first, second], [old, latest], first.seq > second.seq ? old : latest);
      await w.laptop.reset();
    }

    // Variant 2: the laptop publishes while a download is held mid-body; a second open follows.
    {
      w.cover('variant', 'publish_mid_download');
      const label = 'publish while a download is stalled';
      const ph = pick(w.pool);
      await ensureLatest(w, ph);
      const a = await w.laptop.publish();
      const held = await startHeldDownload(w, ph, 0.1 + rng() * 0.8);
      const b = await w.laptop.publish();
      const releaseFirst = w.branch('stall_release') === 'before_second';
      if (releaseFirst) held.release();
      const later = checkedAtResolve(ph.backend.demos.openDemo({ shotType: SHOT }));
      if (!releaseFirst) await Promise.race([later, new Promise((r) => setTimeout(r, 50))]);
      held.release();
      const [first, second] = await Promise.all([checkedAtResolve(held.result), later]);
      // Two unpinned opens must never leave the phone older than a version it already showed.
      await finish(ph, label, [first, second], [a.version, b.version], b.version);
    }
  },

  /** A double-tapped Save: one session, the other call gets recording_missing, nothing stray. */
  async double_save_recording(w) {
    const ph = pick(w.pool);
    w.proxy.mode = laptopMode(w.branch('laptop'));
    const count = async () => Number((await ph.platform.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sessions'))?.n);
    const before = await count();

    const clip = await ph.fakeRecording('mov');
    const s1 = await ph.backend.sessions.saveRecording({ tempUri: clip.uri, durationMs: 8_000 });
    await expectRejects(ph.backend.sessions.saveRecording({ tempUri: clip.uri, durationMs: 8_000 }), 'recording_missing', 'second save after the first finished');

    const clip2 = await ph.fakeRecording('mp4');
    const taps = randInt(2, 4);
    const settled = await Promise.allSettled(Array.from({ length: taps }, () => ph.backend.sessions.saveRecording({ tempUri: clip2.uri, durationMs: 9_000 })));
    const saved = settled.filter((x) => x.status === 'fulfilled');
    const failed = settled.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    assert(saved.length === 1, `${taps} concurrent saves of one clip: ${saved.length} succeeded`);
    for (const f of failed) {
      assert(f.reason instanceof BackendError && f.reason.code === 'recording_missing', `concurrent duplicate save: expected recording_missing, got ${(f.reason as Error)?.name}: ${(f.reason as Error)?.message}`);
    }
    assert((await count()) === before + 2, `expected ${before + 2} sessions, found ${await count()}`);
    const s2 = (saved[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof ph.backend.sessions.saveRecording>>>).value;
    for (const s of [s1, s2]) assert((await ph.backend.sessions.replaySource(s.id)).state === 'available', `session ${s.id} has no playable video`);
    assert((await fileSize(clip.file)) === null && (await fileSize(clip2.file)) === null, 'a clip was left in the camera cache');
  },

  /** Editing history: delete a shot, bad input, totals per session and per drill, across a relaunch. */
  async edit_shots_and_history(w) {
    const ph = await w.fresh();
    const a = await ph.recordSession();
    const b = await ph.recordSession();
    const tags = new Map<string, Map<number, Outcome>>([[a.id, new Map()], [b.id, new Map()]]);
    for (const s of [a, b]) {
      for (let i = 0; i < randInt(3, 8); i++) {
        const shot = await ph.backend.shots.addShot(s.id, i * 900, pick(OUTCOMES));
        tags.get(s.id)!.set(shot.shotNumber, shot.outcome);
      }
    }
    await expectRejects(ph.backend.shots.addShot(a.id, -1), 'invalid_input', 'negative release time');
    await expectRejects(ph.backend.shots.addShot(a.id, Number.NaN), 'invalid_input', 'NaN release time');
    await expectRejects(ph.backend.shots.addShot(a.id, 10, 'swish' as Outcome), 'invalid_input', 'unknown outcome');
    await expectRejects(ph.backend.shots.setOutcome(a.id, 999, 'made'), 'not_found', 'tag a shot that does not exist');
    await expectRejects(ph.backend.shots.setOutcome(a.id, 1, 'swish' as Outcome), 'invalid_input', 'tag with an unknown outcome');
    const bad = await ph.fakeRecording('mov');
    await expectRejects(ph.backend.sessions.saveRecording({ tempUri: bad.uri, durationMs: -5 }), 'invalid_input', 'negative duration');
    assert((await fileSize(bad.file)) !== null, 'a rejected save moved the clip out of the camera cache');
    await rm(bad.file);

    // Shot numbers identify a shot for good: a deleted number is never handed out again,
    // not even after deleting the newest shot, and not after a relaunch.
    let highest = Math.max(...tags.get(a.id)!.keys());
    const victim = pick([...tags.get(a.id)!.keys()]);
    await ph.backend.shots.deleteShot(a.id, victim);
    tags.get(a.id)!.delete(victim);
    await ph.backend.shots.deleteShot(a.id, victim); // no-op
    const addAfterDelete = async (when: string) => {
      const added = await ph.backend.shots.addShot(a.id, 20_000, 'made');
      assert(added.shotNumber > highest, `${when}: new shot got #${added.shotNumber}, but #${highest} was already issued (numbers must never be reused)`);
      highest = added.shotNumber;
      tags.get(a.id)!.set(added.shotNumber, 'made');
    };
    await addAfterDelete('after deleting a shot');
    await ph.backend.shots.deleteShot(a.id, highest); // delete the newest shot
    tags.get(a.id)!.delete(highest);
    await addAfterDelete('after deleting the newest shot');
    await ph.backend.shots.deleteShot(a.id, highest);
    tags.get(a.id)!.delete(highest);
    await ph.relaunch();
    await addAfterDelete('after deleting the newest shot and relaunching');

    const expect = async (when: string) => {
      const total = { made: 0, missed: 0, unmarked: 0 };
      for (const s of [a, b]) {
        const c = { made: 0, missed: 0, unmarked: 0 };
        for (const o of tags.get(s.id)!.values()) c[o]++, total[o]++;
        const st = await ph.backend.shots.stats(s.id);
        assert(st.made === c.made && st.missed === c.missed && st.unmarked === c.unmarked, `${when}: session stats ${json(st)} vs ${json(c)}`);
        const list = await ph.backend.shots.list(s.id);
        assert(json(list.map((x) => x.shotNumber)) === json([...tags.get(s.id)!.keys()].sort((x, y) => x - y)), `${when}: shot list ${list.map((x) => x.shotNumber)}`);
      }
      const all = await ph.backend.shots.overall(SHOT);
      const att = total.made + total.missed;
      assert(all.made === total.made && all.missed === total.missed && all.unmarked === total.unmarked && all.attempts === att, `${when}: drill totals ${json(all)} vs ${json(total)}`);
      assert(att === 0 ? all.percentage === null : Math.abs(all.percentage! - total.made / att) < 1e-9, `${when}: drill percentage`);
      const none = await ph.backend.shots.overall('free_throw');
      assert(none.attempts === 0 && none.percentage === null && none.unmarked === 0, `${when}: empty drill should be the empty state, got ${json(none)}`);
      const listed = await ph.backend.sessions.listWithStats();
      assert(listed.every((x, i) => i === 0 || listed[i - 1]!.createdAt >= x.createdAt), `${when}: Saved Clips not newest first`);
    };
    await expect('before relaunch');
    await ph.relaunch();
    await expect('after relaunch');
  },

  /** Files damaged outside the app: replay degrades, a broken model is never shown, both recover. */
  async damaged_files(w) {
    const ph = await w.fresh();
    const demo = await ensureLatest(w, ph);
    const s = await ph.recordSession();
    await ph.backend.shots.addShot(s.id, 1_000, 'made');
    await ph.backend.shots.addShot(s.id, 2_000, 'missed');

    await rm(ph.path('Documents', ...s.videoPath!.split('/')));
    const gone = await ph.backend.sessions.replaySource(s.id);
    assert(gone.state === 'unavailable' && gone.reason === 'missing', `deleted video: expected unavailable/missing, got ${json(gone)}`);
    const { reclaimedBytes } = await ph.backend.sessions.removeVideo(s.id);
    assert(reclaimedBytes === 0, `removing a missing video reclaimed ${reclaimedBytes}`);
    assert((await ph.backend.sessions.removeVideo(s.id)).reclaimedBytes === 0, 'second removeVideo is not a no-op');
    const st = await ph.backend.shots.stats(s.id);
    assert(st.made === 1 && st.missed === 1, `stats lost with the video: ${json(st)}`);

    const model = ph.path('Documents', ...demo.localPath.split('/'));
    const bytes = await readFile(model);
    await writeFile(model, bytes.subarray(0, randInt(1, bytes.length - 1)));
    w.proxy.mode = { kind: 'down' };
    if (w.branch('recovery') === 'relaunch') {
      const rec = await ph.relaunch();
      assert(rec.brokenDemoRowsRemoved >= 1, `recovery kept a damaged model row: ${json(rec)}`);
    }
    const r = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'unavailable' && r.code === 'unreachable', `a damaged model must not open: ${json(r)}`);
    assert((await readdir(ph.path('Documents', 'models'))).length === 0, 'damaged model file left on disk');
    w.proxy.mode = { kind: 'pass' };
    const again = await ph.backend.demos.openDemo({ shotType: SHOT });
    await expectReadyVersion(w, ph, again, w.laptop.latest.version, 'downloaded', 're-download after damage');
  },

  /** storageUsage reports what is on disk, and removing a video reclaims exactly its size. */
  async storage_usage_accounting(w) {
    const ph = await w.fresh();
    const u0 = await ph.backend.storageUsage();
    assert(u0.videosBytes === 0 && u0.modelsBytes === 0 && u0.freeBytes > 0, `new phone usage ${json(u0)}`);
    const s1 = await ph.recordSession();
    const s2 = await ph.recordSession();
    const demo = await ensureLatest(w, ph);
    const u1 = await ph.backend.storageUsage();
    assert(u1.videosBytes === s1.sizeBytes! + s2.sizeBytes! && u1.modelsBytes === demo.sizeBytes, `usage ${json(u1)} vs videos ${s1.sizeBytes}+${s2.sizeBytes}, model ${demo.sizeBytes}`);
    const { reclaimedBytes } = await ph.backend.sessions.removeVideo(pick([s1, s2]).id);
    const u2 = await ph.backend.storageUsage();
    assert(u2.videosBytes === u1.videosBytes - reclaimedBytes && reclaimedBytes > 0, `after removing a video: ${json(u2)}, reclaimed ${reclaimedBytes}`);
    ph.freeBytesOverride = 123_456;
    assert((await ph.backend.storageUsage()).freeBytes === 123_456, 'free space not reported from the platform');
  },

  /**
   * Kills the app at every await point of its own launch (migrations on a
   * fresh install, then the recovery sweep with leftovers on disk). The next
   * launch must finish the job and keep every session, shot and model.
   */
  async kill_during_launch(w) {
    // Fresh install: die inside initDatabase or the first sweep, then launch again.
    w.cover('install', 'fresh');
    let reachedEnd = false;
    for (let k = 1; k < 400 && !reachedEnd; k++) {
      for (const land of [false, true]) {
        const ph = await w.fresh({ call: k, land });
        if (!ph.dead) {
          // The launch finished before call k: every await point has been covered.
          assert(k > 5, `fresh-install launch made only ${k - 1} port calls; the sweep is not reaching it`);
          reachedEnd = true;
          break;
        }
        const where = `fresh install killed at launch await point ${k}, ${ph.platform.process.diedAt}`;
        try {
          await ph.launch();
          await checkInvariants(ph, w.laptop);
          const s = await ph.recordSession();
          await ph.backend.shots.addShot(s.id, 100, 'made');
          assert((await ph.backend.shots.stats(s.id)).made === 1, 'stats');
        } catch (err) {
          throw new AssertionFailed(`${where}: ${(err as Error).message}`);
        }
      }
    }
    assert(reachedEnd, 'fresh-install kill sweep never reached the end of the launch');
    w.cover('install', 'existing');

    // Existing install with leftovers to sweep.
    const ph = await w.fresh();
    const demo = await ensureLatest(w, ph);
    const s = await ph.recordSession();
    await ph.backend.shots.addShot(s.id, 500, 'made');
    await ph.backend.shots.addShot(s.id, 900, 'missed');
    for (let k = 1; k < 400; k++) {
      for (const land of [false, true]) {
        await mkdir(ph.path('Caches', 'perspective-downloads'), { recursive: true });
        await writeFile(ph.path('Caches', 'perspective-downloads', `${DEMO_ID}-v99.usdz.${randomUUID()}.part`), randomBytes(64));
        await writeFile(ph.path('Documents', 'models', `${DEMO_ID}-v98.usdz`), randomBytes(64));
        await writeFile(ph.path('Documents', 'videos', `${randomUUID()}.mov`), randomBytes(64));
        await ph.close();
        const rec = await ph.launch({ call: k, land });
        if (rec) {
          // Launch finished before call k: every await point has been covered.
          assert(k > 5, `launch made only ${k - 1} port calls; the sweep is not reaching it`);
          return;
        }
        const where = `existing install killed at launch await point ${k}, ${ph.platform.process.diedAt}`;
        try {
          await ph.launch();
          await checkInvariants(ph, w.laptop);
          w.proxy.mode = { kind: 'down' };
          const r = await ph.backend.demos.openDemo({ shotType: SHOT });
          assert(r.status === 'ready' && r.source === 'local' && r.demo.version === demo.version, `model lost: ${json(r)}`);
          const st = await ph.backend.shots.stats(s.id);
          assert(st.made === 1 && st.missed === 1, `stats lost: ${json(st)}`);
          assert((await ph.backend.sessions.replaySource(s.id)).state === 'available', 'video lost');
          w.proxy.mode = { kind: 'pass' };
        } catch (err) {
          throw new AssertionFailed(`${where}: ${(err as Error).message}`);
        }
      }
    }
    throw new AssertionFailed('launch kill sweep never reached the end of the launch');
  },

  /** The catalog's headers arrive but its body stalls: time out, keep the saved model, and later opens still work. */
  async stalled_catalog_body(w) {
    const ph = pick(w.pool);
    const saved = await ensureLatest(w, ph);
    const fresh = await w.fresh();
    const hold = deferred();
    w.proxy.mode = { kind: 'stall_catalog_body', until: hold.promise };
    const budget = CATALOG_TIMEOUT_MS + 1_000;
    const timed = async (p: Promise<OpenDemoResult>, what: string) => {
      const t0 = Date.now();
      const r = await Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), budget * 3))]);
      assert(r, `${what}: openDemo still pending after ${budget * 3} ms with the catalog body stalled`);
      const ms = Date.now() - t0;
      assert(ms <= budget, `${what}: took ${ms} ms, expected about ${CATALOG_TIMEOUT_MS} ms`);
      return r;
    };
    try {
      const r = await timed(ph.backend.demos.openDemo({ shotType: SHOT }), 'phone with a model');
      assert(r.status === 'ready' && r.source === 'local' && r.demo.version === saved.version && r.fallback?.code === 'timeout', `expected saved v${saved.version} with timeout, got ${json(r)}`);
      const f = await timed(fresh.backend.demos.openDemo({ shotType: SHOT }), 'new phone');
      assert(f.status === 'unavailable' && f.code === 'timeout', `new phone: expected unavailable/timeout, got ${json(f)}`);
    } finally {
      hold.resolve();
    }
    w.proxy.mode = { kind: 'pass' };
    const next = await timed(ph.backend.demos.openDemo({ shotType: SHOT }), 'open after the stall');
    await expectReadyVersion(w, ph, next, saved.version, 'local', 'open after the stall');
    const got = await timed(fresh.backend.demos.openDemo({ shotType: SHOT }), 'new phone after the stall');
    await expectReadyVersion(w, fresh, got, w.laptop.latest.version, 'downloaded', 'new phone after the stall');
  },

  /** Two concurrent removeVideo calls: exactly one reclaims the bytes, stats untouched. */
  async remove_video_twice(w) {
    const ph = pick(w.pool);
    const s = await ph.recordSession();
    await ph.backend.shots.addShot(s.id, 700, 'made');
    await ph.backend.shots.addShot(s.id, 1_700, 'unmarked');
    const before = await ph.backend.shots.stats(s.id);
    const n = randInt(2, 4);
    const settled = await Promise.allSettled(Array.from({ length: n }, () => ph.backend.sessions.removeVideo(s.id)));
    const failed = settled.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    assert(failed.length === 0, `concurrent removeVideo rejected: ${failed.map((f) => (f.reason as Error)?.message)}`);
    const reclaimed = settled.map((x) => (x as PromiseFulfilledResult<{ reclaimedBytes: number }>).value.reclaimedBytes);
    assert(reclaimed.filter((b) => b > 0).length === 1, `${n} concurrent removeVideo calls reported reclaimed bytes ${reclaimed}; exactly one should`);
    assert(reclaimed.find((b) => b > 0) === s.sizeBytes, `reclaimed ${reclaimed} but the video was ${s.sizeBytes} bytes`);
    assert((await fileSize(ph.path('Documents', ...s.videoPath!.split('/')))) === null, 'video still on disk');
    const after = await ph.backend.shots.stats(s.id);
    assert(json(after) === json(before), `stats changed: ${json(after)} vs ${json(before)}`);
    const replay = await ph.backend.sessions.replaySource(s.id);
    assert(replay.state === 'unavailable' && replay.reason === 'removed', `replay ${json(replay)}`);
  },

  /**
   * Kills the app at every await point of saveRecording (before and after each
   * call lands). After the relaunch the clip is never lost: it is either a
   * session whose video is the intact clip, or still in the camera cache.
   */
  async kill_during_save(w) {
    const ph = await w.fresh();
    for (let k = 1; k < 400; k++) {
      for (const land of [false, true]) {
        w.cover('land', land ? 'after_call' : 'before_call');
        const clip = await ph.fakeRecording(pick(['mov', 'mp4']));
        const clipSha = sha(await readFile(clip.file));
        const before = new Set((await ph.backend.sessions.listWithStats()).map((x) => x.id));
        const proc = ph.platform.process;
        proc.killAtCall(k, land);
        const save = ph.backend.sessions.saveRecording({ tempUri: clip.uri, durationMs: randInt(1_000, 30_000) });
        const done = await Promise.race([save.then((v) => ({ v }), (err) => ({ err })), proc.died.then(() => null)]);
        if (done) {
          // saveRecording finished before call k: every await point has been covered.
          proc.disarm();
          assert(!('err' in done), `uninterrupted save failed: ${(done as { err: Error }).err?.message}`);
          assert(k > 3, `saveRecording made only ${k - 1} port calls; the sweep is not reaching it`);
          return;
        }
        const where = `killed at save await point ${k}, ${proc.diedAt}`;
        let inCache = false;
        try {
          await ph.relaunch();
          await checkInvariants(ph, w.laptop);
          inCache = (await fileSize(clip.file)) !== null;
          if (inCache) assert(sha(await readFile(clip.file)) === clipSha, 'clip in the camera cache is damaged');
          const added = (await ph.backend.sessions.listWithStats()).filter((x) => !before.has(x.id));
          const holding = await sessionsHoldingBytes(ph, clipSha);
          assert(inCache || holding.length === 1, 'the recording was lost: not in the camera cache and no session holds it');
          assert(!(inCache && holding.length > 0), 'the recording is both saved and still in the camera cache (a second save would duplicate it)');
          assert(added.length === holding.length && added.every((x) => holding.includes(x.id)), `stray sessions after the kill: ${json(added.map((x) => x.id))}`);
          for (const id of holding) assert((await ph.backend.sessions.replaySource(id)).state === 'available', 'saved clip does not play');
        } catch (err) {
          throw new AssertionFailed(`${where}: ${(err as Error).message}`);
        }
        // The player saves the clip again from the camera cache; that must work.
        if (inCache) await ph.backend.sessions.saveRecording({ tempUri: clip.uri, durationMs: 5_000 });
      }
    }
    throw new AssertionFailed('save kill sweep never reached the end of saveRecording');
  },

  /**
   * Kills the app at every await point of deleteSession and of removeVideo.
   * Whatever had committed stays true after the relaunch: a deleted session
   * or a removed video never comes back, not even adopted as a new session.
   */
  async kill_during_delete(w) {
    const ph = await w.fresh();
    for (const op of ['deleteSession', 'removeVideo'] as const) {
      w.cover('op', op);
      let reachedEnd = false;
      for (let k = 1; k < 400 && !reachedEnd; k++) {
        for (const land of [false, true]) {
          const s = await ph.recordSession();
          await ph.backend.shots.addShot(s.id, 400, 'made');
          await ph.backend.shots.addShot(s.id, 800, 'missed');
          const videoSha = sha(await readFile(ph.path('Documents', ...s.videoPath!.split('/'))));
          const proc = ph.platform.process;
          proc.killAtCall(k, land);
          const call = op === 'deleteSession' ? ph.backend.sessions.deleteSession(s.id) : ph.backend.sessions.removeVideo(s.id);
          const done = await Promise.race([call.then(() => true), proc.died.then(() => null)]);
          if (done) {
            proc.disarm();
            assert(k > 2, `${op} made only ${k - 1} port calls; the sweep is not reaching it`);
            reachedEnd = true;
            break;
          }
          const committed = durableSession(ph, s.id);
          const where = `${op} killed at await point ${k}, ${proc.diedAt}`;
          try {
            await ph.relaunch();
            await checkInvariants(ph, w.laptop);
            const now = await ph.backend.sessions.get(s.id);
            if (!committed.exists) {
              assert(now === null, 'the deleted session came back after the relaunch');
            } else if (committed.videoPath === null) {
              assert(now && now.videoPath === null, `the removed video came back: ${json(now)}`);
              const replay = await ph.backend.sessions.replaySource(s.id);
              assert(replay.state === 'unavailable' && replay.reason === 'removed', `replay ${json(replay)}`);
            } else {
              assert(now && now.videoPath === committed.videoPath, `session changed although nothing committed: ${json(now)}`);
              assert((await ph.backend.sessions.replaySource(s.id)).state === 'available', 'video lost although nothing committed');
            }
            const holders = await sessionsHoldingBytes(ph, videoSha);
            const allowed = committed.exists && committed.videoPath !== null ? [s.id] : [];
            assert(json(holders) === json(allowed), `video bytes held by ${json(holders)}, expected ${json(allowed)} (a deleted video must not be adopted)`);
            if (now) {
              const st = await ph.backend.shots.stats(s.id);
              assert(st.made === 1 && st.missed === 1, `stats lost: ${json(st)}`);
            }
          } catch (err) {
            throw new AssertionFailed(`${where}: ${(err as Error).message}`);
          }
          // The player repeats the action; it completes.
          if (op === 'deleteSession') await ph.backend.sessions.deleteSession(s.id);
          else if (await ph.backend.sessions.get(s.id)) await ph.backend.sessions.removeVideo(s.id);
        }
      }
      assert(reachedEnd, `${op} kill sweep never reached the end`);
    }
  },

  /**
   * addShot runs alongside removeVideo/deleteSession, and the app is killed
   * the moment the delete resolves. A delete the app reported as done must
   * still be done after the relaunch, and a shot that resolved must exist.
   * The SQLite queue is made slow relative to file I/O (as on a busy phone)
   * and addShot's start is stepped one event-loop turn at a time across the
   * whole time the delete is running, so every interleaving is tried.
   */
  async kill_after_resolved_delete(w) {
    const op = w.branch('op');
    const ph = await w.fresh();
    const SQL_LATENCY_TURNS = 16;
    let overlapping = 0;
    for (let delay = 0; delay < 2_000; delay++) {
      const tagged = await ph.recordSession();
      const target = await ph.recordSession();
      ph.platform.db.setLatency(SQL_LATENCY_TURNS);
      let deleteDone = false;
      const del = (op === 'deleteSession' ? ph.backend.sessions.deleteSession(target.id) : ph.backend.sessions.removeVideo(target.id)).then(() => {
        deleteDone = true;
      });
      for (let i = 0; i < delay; i++) await new Promise<void>((r) => setImmediate(r));
      if (deleteDone) {
        // addShot would start after the delete finished: every overlap has been tried.
        await del;
        ph.platform.db.setLatency(0);
        assert(overlapping >= 10, `only ${overlapping} overlapping starts were tried; the sweep is not covering the ${op}`);
        return;
      }
      overlapping++;
      let shot: { shotNumber: number } | null = null;
      void ph.backend.shots.addShot(tagged.id, 100 + delay, 'made').then((x) => (shot = x), () => undefined);
      await del; // the screen now says it is gone
      ph.kill();
      const where = `${op} resolved, then the app was killed (addShot started ${delay} event-loop turns into the ${op})`;
      try {
        await ph.relaunch();
        await checkInvariants(ph, w.laptop);
        const now = await ph.backend.sessions.get(target.id);
        if (op === 'deleteSession') {
          assert(now === null, `the deleted session is back after the relaunch: ${json(now)}`);
        } else {
          assert(now && now.videoPath === null, `the removed video is back after the relaunch: ${json(now)}`);
          const replay = await ph.backend.sessions.replaySource(target.id);
          assert(replay.state === 'unavailable' && replay.reason === 'removed', `replay ${json(replay)}`);
        }
        const resolved = shot as { shotNumber: number } | null;
        if (resolved) {
          const list = await ph.backend.shots.list(tagged.id);
          assert(list.some((x) => x.shotNumber === resolved.shotNumber), `addShot resolved #${resolved.shotNumber} before the kill, but the shot is gone`);
        }
      } catch (err) {
        throw new AssertionFailed(`${where}: ${(err as Error).message}`);
      }
      await ph.backend.sessions.deleteSession(tagged.id);
      await ph.backend.sessions.deleteSession(target.id);
    }
    throw new AssertionFailed(`the ${op} never finished within the sweep`);
  },

  /** A phone on the v1 database upgrades: shots kept, numbering continues at MAX+1; also with a kill at every launch await point. */
  async migrate_v1_database(w) {
    {
      const { ph, sessions } = await buildV1Phone(w);
      await ph.launch();
      await checkUpgraded(ph, w.laptop, sessions);
    }
    for (let k = 1; k < 400; k++) {
      for (const land of [false, true]) {
        const { ph, sessions } = await buildV1Phone(w);
        const rec = await ph.launch({ call: k, land });
        if (rec) {
          assert(k > 5, `the upgrade launch made only ${k - 1} port calls; the sweep is not reaching it`);
          await checkUpgraded(ph, w.laptop, sessions);
          return;
        }
        const where = `v1→v${SCHEMA_VERSION} launch killed at await point ${k}, ${ph.platform.process.diedAt}`;
        try {
          await ph.launch();
          await checkUpgraded(ph, w.laptop, sessions);
        } catch (err) {
          throw new AssertionFailed(`${where}: ${(err as Error).message}`);
        }
        await ph.close();
      }
    }
    throw new AssertionFailed('upgrade kill sweep never reached the end of the launch');
  },

  /** A build with no laptop URL: health and opens say not_configured, a saved model still opens, recording works. */
  async not_configured(w) {
    const missing = w.branch('config') === 'null' ? null : pick(['', '   ']);
    const ph = await w.fresh();
    const saved = await ensureLatest(w, ph);
    const fresh = w.unlaunched();
    fresh.apiBase = missing;
    await fresh.launch();
    ph.apiBase = missing;
    await ph.relaunch();
    const before = w.proxy.counters.requests;

    const h = await fresh.backend.api.health();
    assert(!h.ok && h.code === 'not_configured', `health without a laptop URL: ${json(h)}`);
    const r = await fresh.backend.demos.openDemo({ shotType: SHOT });
    assert(r.status === 'unavailable' && r.code === 'not_configured', `new phone: expected unavailable/not_configured, got ${json(r)}`);
    const kept = await ph.backend.demos.openDemo({ shotType: SHOT });
    assert(kept.status === 'ready' && kept.source === 'local' && kept.demo.version === saved.version && kept.fallback?.code === 'not_configured', `saved model: expected v${saved.version} with not_configured, got ${json(kept)}`);
    assert((await ph.fileSha(kept.demo.uri)) === w.laptop.versions.get(saved.version)!.sha, 'saved model bytes changed');
    const s = await fresh.recordSession();
    await fresh.backend.shots.addShot(s.id, 300, 'made');
    assert((await fresh.backend.shots.stats(s.id)).made === 1, 'recording/tagging broke without a laptop URL');
    assert(w.proxy.counters.requests === before, `a build without a laptop URL made ${w.proxy.counters.requests - before} network requests`);
  },

  /** The row change fails (disk error): removeVideo, deleteSession and saveRecording put the file back. */
  async row_change_fails(w) {
    const ph = pick(w.pool);
    const db = ph.platform.db;
    const videoOf = (s: { videoPath: string | null }) => ph.path('Documents', ...s.videoPath!.split('/'));
    const trashEmpty = async (what: string) => {
      const t = await readdir(ph.path('Caches', 'perspective-trash')).catch(() => []);
      assert(t.length === 0, `${what}: file left in the trash ${t}`);
    };

    for (const op of ['removeVideo', 'deleteSession'] as const) {
      w.cover('op', op);
      const s = await ph.recordSession();
      await ph.backend.shots.addShot(s.id, 400, 'made');
      const bytes = sha(await readFile(videoOf(s)));
      db.failNext(op === 'removeVideo' ? /^UPDATE sessions SET video_path = NULL/ : /^DELETE FROM sessions/);
      const call = op === 'removeVideo' ? ph.backend.sessions.removeVideo(s.id) : ph.backend.sessions.deleteSession(s.id);
      const out = await call.then(() => 'resolved', (err) => err as Error);
      assert(out instanceof Error, `${op} resolved although its row change failed`);
      const now = await ph.backend.sessions.get(s.id);
      assert(now && now.videoPath === s.videoPath, `${op} failed but the session changed: ${json(now)}`);
      assert((await fileSize(videoOf(s))) !== null && sha(await readFile(videoOf(s))) === bytes, `${op} failed but the video was not put back`);
      assert((await ph.backend.sessions.replaySource(s.id)).state === 'available', `${op} failed and the video no longer plays`);
      assert((await ph.backend.shots.stats(s.id)).made === 1, `${op} failed and the stats changed`);
      await trashEmpty(op);
      await checkInvariants(ph, w.laptop);
      if (op === 'removeVideo') assert((await ph.backend.sessions.removeVideo(s.id)).reclaimedBytes === s.sizeBytes, 'retry did not reclaim the video');
      else await ph.backend.sessions.deleteSession(s.id);
    }

    w.cover('op', 'saveRecording');
    const clip = await ph.fakeRecording('mov');
    const bytes = sha(await readFile(clip.file));
    const ids = new Set((await ph.backend.sessions.listWithStats()).map((x) => x.id));
    db.failNext(/^INSERT INTO sessions/);
    const out = await ph.backend.sessions.saveRecording({ tempUri: clip.uri, durationMs: 7_000 }).then(() => 'resolved', (err) => err as Error);
    assert(out instanceof Error, 'saveRecording resolved although its INSERT failed');
    assert((await fileSize(clip.file)) !== null && sha(await readFile(clip.file)) === bytes, 'saveRecording failed and the clip is no longer in the camera cache');
    assert((await ph.backend.sessions.listWithStats()).every((x) => ids.has(x.id)), 'a session row appeared although the INSERT failed');
    await checkInvariants(ph, w.laptop);
    const saved = await ph.backend.sessions.saveRecording({ tempUri: clip.uri, durationMs: 7_000 });
    assert((await ph.backend.sessions.replaySource(saved.id)).state === 'available', 'retry save does not play');
  },

  /**
   * Signed in: tag shots (near the start, mid, near the end), sync. Exactly
   * one clip per shot with the right outcome; each clip's real length, read
   * from the file, is min(dur, r+1000) - max(0, r-3000) within one frame, and
   * the full recording is gone from blob storage. A second sync does nothing.
   */
  async clip_sync_windows(w) {
    const withAudio = w.branch('audio') === 'with';
    const ph = await w.fresh();
    const A = CLOUD.users.A;
    ph.auth = { kind: 'user', user: A };
    const pool = VIDEOS.filter((v) => v.audio === withAudio);
    const video = pick(pool);
    const dur = video.durationMs;
    const releases = [randInt(0, Math.min(2_999, dur)), randInt(Math.max(0, dur - 999), dur)];
    if (dur > 4_001) releases.push(randInt(3_000, dur - 1_001));
    const { s, shots } = await taggedSession(ph, releases, (v) => v === video);
    await expectStates(ph, s.id, 'pending', 'before sync');
    const c0 = { ...w.proxy.counters };
    const report = await syncOk(ph, 'first sync');
    assert(report.uploaded === shots.size, `uploaded ${report.uploaded} of ${shots.size}`);
    assert(w.proxy.counters.uploads - c0.uploads === 1 && w.proxy.counters.clipCuts - c0.clipCuts === 1, `expected one recording upload and one cut request, saw ${w.proxy.counters.uploads - c0.uploads} and ${w.proxy.counters.clipCuts - c0.clipCuts}`);
    await expectStates(ph, s.id, 'synced', 'after sync');
    expectServer(s.id, A, outcomesOf(shots), 'after sync');
    await noRecordingLeft(s.id, 'after sync');

    const frameMs = 1000 / video.fps;
    for (const r of serverRows(s.id)) {
      const rel = shots.get(r.shotNumber)!.releaseMs;
      const startMs = Math.max(0, rel - 3_000);
      const endMs = Math.min(dur, rel + 1_000);
      assert(r.startMs === startMs && r.endMs === endMs, `clip #${r.shotNumber} (release ${rel} ms of ${dur}): window ${r.startMs}-${r.endMs}, expected ${startMs}-${endMs}`);
      const info = await videoInfo(CLOUD.deps.blob.fileOf(r.clipPathname));
      const realMs = (info.frames * 1000) / video.fps;
      assert(Math.abs(realMs - (endMs - startMs)) <= frameMs + 1, `clip #${r.shotNumber} (release ${rel} ms of ${dur}): ${info.frames} frames = ${realMs.toFixed(1)} ms, expected ${endMs - startMs} ms within one frame`);
      assert(info.videoCodec === 'h264', `clip #${r.shotNumber}: video codec ${info.videoCodec}`);
      assert((info.audioCodec === 'aac') === withAudio, `clip #${r.shotNumber}: audio ${info.audioCodec}, source ${withAudio ? 'has' : 'has no'} audio`);
    }

    const c1 = { ...w.proxy.counters };
    await syncOk(ph, 'second sync');
    assert(w.proxy.counters.cloudCalls === c1.cloudCalls, `a sync with nothing to do made ${w.proxy.counters.cloudCalls - c1.cloudCalls} cloud calls`);
  },

  /** Shots tagged while signed out (or pending when the player signs out) never leave the phone, even after a later sign-in. */
  async clip_sync_signed_out(w) {
    const when = w.branch('when');
    const ph = await w.fresh();
    const A = CLOUD.users.A;
    if (when === 'signed_out_before_sync') ph.auth = { kind: 'user', user: A };
    const s0 = await ph.recordSession();
    const { s, shots } = { s: s0, shots: new Map<number, Outcome>() };
    for (const r of someReleases(s.video.durationMs, randInt(2, 4))) shots.set((await ph.backend.shots.addShot(s.id, r, pick(OUTCOMES))).shotNumber, 'made');
    await expectStates(ph, s.id, when === 'signed_out_throughout' ? 'local_only' : 'pending', 'after tagging');
    ph.auth = { kind: 'signed_out' };
    const c0 = w.proxy.counters.cloudCalls;
    const report = await sync(ph);
    assert(report.skippedSignedOut === (when === 'signed_out_throughout' ? 0 : shots.size), `signed-out sync: ${json(report)}`);
    await expectStates(ph, s.id, 'local_only', 'after a signed-out sync');
    assert(w.proxy.counters.cloudCalls === c0, `signed out, the phone made ${w.proxy.counters.cloudCalls - c0} cloud calls`);

    ph.auth = { kind: 'user', user: A };
    await syncOk(ph, 'after signing in');
    await expectStates(ph, s.id, 'local_only', 'after signing in');
    assert(w.proxy.counters.cloudCalls === c0, `shots tagged while signed out were uploaded after a later sign-in (${w.proxy.counters.cloudCalls - c0} cloud calls)`);
    assert(serverRows(s.id).length === 0, 'server holds clips of shots tagged while signed out');

    const late = await ph.backend.shots.addShot(s.id, randInt(0, s.video.durationMs), 'made');
    await syncOk(ph, 'a shot tagged after sign-in');
    expectServer(s.id, A, new Map([[late.shotNumber, 'made' as Outcome]]), 'a shot tagged after sign-in');
    await expectStates(ph, s.id, (n) => (n === late.shotNumber ? 'synced' : 'local_only'), 'a shot tagged after sign-in');
  },

  /** Offline, a server error or an expired token: shots stay pending, nothing is stored, the next sync succeeds. */
  async clip_sync_retry(w) {
    const A = CLOUD.users.A;
    for (const fault of ['offline', 'http500', 'expired_token'] as const) {
      w.cover('fault', fault);
      const ph = await w.fresh();
      ph.auth = { kind: 'user', user: A };
      const { s, shots } = await taggedSession(ph, someReleases(VIDEOS[0]!.durationMs, randInt(1, 3)), (v) => v === VIDEOS[0]);
      if (fault === 'offline') w.proxy.mode = { kind: 'down' };
      if (fault === 'http500') w.proxy.mode = { kind: 'http500' };
      if (fault === 'expired_token') ph.auth = { kind: 'expired', user: A };
      const report = await sync(ph);
      assert(report.errors.length > 0 && report.uploaded === 0 && report.pending === shots.size, `${fault}: ${json(report)}`);
      await expectStates(ph, s.id, 'pending', fault);
      assert(serverRows(s.id).length === 0, `${fault}: server stored clips`);
      w.proxy.mode = { kind: 'pass' };
      ph.auth = { kind: 'user', user: A };
      await syncOk(ph, `${fault}, next sync`);
      await expectStates(ph, s.id, 'synced', `${fault}, next sync`);
      expectServer(s.id, A, outcomesOf(shots), `${fault}, next sync`);
      await noRecordingLeft(s.id, `${fault}, next sync`);
    }
  },

  /** After a sync: an outcome edit is PATCHed; a deleted shot or session is deleted remotely. */
  async clip_sync_edits(w) {
    const A = CLOUD.users.A;
    const ph = await w.fresh();
    ph.auth = { kind: 'user', user: A };
    for (const edit of ['outcome', 'delete_shot', 'delete_session'] as const) {
      w.cover('edit', edit);
      const { s, shots } = await taggedSession(ph, someReleases(VIDEOS[0]!.durationMs, 3), (v) => v === VIDEOS[0]);
      await syncOk(ph, `${edit}: first sync`);
      const want = outcomesOf(shots);
      const n = pick([...shots.keys()]);
      if (edit === 'outcome') {
        const next = pick(OUTCOMES.filter((o) => o !== want.get(n)));
        await ph.backend.shots.setOutcome(s.id, n, next);
        want.set(n, next);
        await expectStates(ph, s.id, (x) => (x === n ? 'outcome_dirty' : 'synced'), 'after the edit');
        const r = await syncOk(ph, 'outcome edit sync');
        assert(r.patched === 1, `expected one PATCH, report ${json(r)}`);
        await expectStates(ph, s.id, 'synced', 'after the PATCH');
        expectServer(s.id, A, want, 'after the PATCH');
      } else if (edit === 'delete_shot') {
        await ph.backend.shots.deleteShot(s.id, n);
        want.delete(n);
        assert((await queuedDeletes(ph)) === 1, 'deleting a synced shot did not queue a remote delete');
        const r = await syncOk(ph, 'shot delete sync');
        assert(r.deleted === 1, `expected one remote delete, report ${json(r)}`);
        expectServer(s.id, A, want, 'after the remote shot delete');
      } else {
        await ph.backend.sessions.deleteSession(s.id);
        const r = await syncOk(ph, 'session delete sync');
        assert(r.deleted >= 1, `expected a remote session delete, report ${json(r)}`);
        expectServer(s.id, A, new Map(), 'after the remote session delete');
        const left = (await blobFiles('clips')).filter((p) => p.includes(`/${s.id}/`));
        assert(left.length === 0, `clip blobs left after the session delete: ${left}`);
      }
    }
  },

  /** User B never sees, changes or deletes user A's clips. */
  async clip_sync_isolation(w) {
    const { A, B } = CLOUD.users;
    const pa = await w.fresh();
    pa.auth = { kind: 'user', user: A };
    const pb = await w.fresh();
    pb.auth = { kind: 'user', user: B };
    const a = await taggedSession(pa, someReleases(VIDEOS[0]!.durationMs, 2), (v) => v === VIDEOS[0]);
    const b = await taggedSession(pb, someReleases(VIDEOS[0]!.durationMs, 1), (v) => v === VIDEOS[0]);
    await syncOk(pa, 'A sync');
    await syncOk(pb, 'B sync');
    const tokenB = await CLOUD.token(B);
    const list = (await (await fetch(`${w.proxy.url}/v1/clips`, { headers: { authorization: `Bearer ${tokenB}` } })).json()) as { clips: { sessionId: string }[] };
    assert(list.clips.length > 0 && list.clips.every((c) => c.sessionId !== a.s.id), `B's clip list shows A's session: ${json(list.clips.map((c) => c.sessionId))}`);
    const onlyA = (await (await fetch(`${w.proxy.url}/v1/clips?sessionId=${a.s.id}`, { headers: { authorization: `Bearer ${tokenB}` } })).json()) as { clips: unknown[] };
    assert(onlyA.clips.length === 0, `B can list A's session by id: ${json(onlyA)}`);
    const n = [...a.shots.keys()][0]!;
    const patched = await pb.backend.api.patchShotOutcome(tokenB, a.s.id, n, 'made').then(() => 'resolved', (err) => (err as BackendError).code);
    assert(patched === 'not_found', `B's PATCH of A's shot: ${patched}`);
    await pb.backend.api.deleteShotClip(tokenB, a.s.id, n);
    await pb.backend.api.deleteSessionClips(tokenB, a.s.id);
    expectServer(a.s.id, A, outcomesOf(a.shots), "A's clips after B's PATCH and DELETEs");
    expectServer(b.s.id, B, outcomesOf(b.shots), "B's own clips");
  },

  /** The video was removed before its clips synced: the shots become unavailable and nothing is uploaded. */
  async clip_sync_video_removed(w) {
    const ph = await w.fresh();
    ph.auth = { kind: 'user', user: CLOUD.users.A };
    const { s, shots } = await taggedSession(ph, someReleases(VIDEOS[0]!.durationMs, randInt(1, 3)), (v) => v === VIDEOS[0]);
    const before = await ph.backend.shots.stats(s.id);
    await ph.backend.sessions.removeVideo(s.id);
    const c0 = w.proxy.counters.cloudCalls;
    const r = await syncOk(ph, 'sync after removing the video');
    assert(r.unavailable === shots.size, `expected ${shots.size} unavailable, report ${json(r)}`);
    await expectStates(ph, s.id, 'unavailable', 'after the sync');
    assert(w.proxy.counters.cloudCalls === c0, `uploaded ${w.proxy.counters.cloudCalls - c0} cloud calls for a removed video`);
    assert(serverRows(s.id).length === 0, 'server stored clips of a removed video');
    assert(json(await ph.backend.shots.stats(s.id)) === json(before), 'stats changed');
  },

  /** A release after the end of the recording: that shot gets a per-shot error and ends unavailable; the others sync. */
  async clip_sync_release_beyond_end(w) {
    const ph = await w.fresh();
    ph.auth = { kind: 'user', user: CLOUD.users.A };
    const s = await ph.recordSession();
    const dur = s.video.durationMs;
    const good = await ph.backend.shots.addShot(s.id, randInt(0, dur), 'made');
    const beyond = await ph.backend.shots.addShot(s.id, dur + randInt(200, 3_000), 'missed');
    const report = await sync(ph);
    assert(report.pending === 0, `the beyond-the-end shot keeps waiting: ${json(report)}`);
    await expectStates(ph, s.id, (n) => (n === good.shotNumber ? 'synced' : 'unavailable'), `release ${beyond.releaseMs} ms of a ${dur} ms recording`);
    expectServer(s.id, CLOUD.users.A, new Map([[good.shotNumber, 'made' as Outcome]]), 'after the sync');
    const c1 = w.proxy.counters.uploads;
    await sync(ph);
    assert(w.proxy.counters.uploads === c1, 'the unavailable shot is uploaded again on the next sync');
  },

  /** Concurrent syncNow calls join one run: one recording upload, one cut request. */
  async clip_sync_concurrent(w) {
    const ph = await w.fresh();
    ph.auth = { kind: 'user', user: CLOUD.users.A };
    const { s, shots } = await taggedSession(ph, someReleases(VIDEOS[0]!.durationMs, 2), (v) => v === VIDEOS[0]);
    await register(ph);
    const c0 = { ...w.proxy.counters };
    const calls = Array.from({ length: randInt(2, 4) }, () => ph.backend.clips.syncNow());
    assert(calls.every((c) => c === calls[0]), 'concurrent syncNow calls started separate runs');
    const reports = await Promise.all(calls);
    assert(reports[0]!.uploaded === shots.size && reports[0]!.errors.length === 0, `report ${json(reports[0])}`);
    assert(w.proxy.counters.uploads - c0.uploads === 1 && w.proxy.counters.clipCuts - c0.clipCuts === 1, `uploads ${w.proxy.counters.uploads - c0.uploads}, cut requests ${w.proxy.counters.clipCuts - c0.clipCuts}`);
    expectServer(s.id, CLOUD.users.A, outcomesOf(shots), 'after the joined run');
  },

  /**
   * Kills the app at every other await point of syncNow (odd or even ones
   * per run, each before and after the call lands) while it uploads a new
   * shot, PATCHes an edited outcome and deletes a shot remotely. After the
   * relaunch and another sync the end state is exact: every shot has exactly
   * one clip with its outcome, the deleted one has none, queues are empty,
   * and at most one extra recording upload happened.
   */
  async clip_sync_kill_sweep(w) {
    const start = w.branch('await_points') === 'odd' ? 1 : 2;
    const A = CLOUD.users.A;
    const ph = await w.fresh();
    ph.auth = { kind: 'user', user: A };
    const video = VIDEOS.reduce((a, b) => (a.durationMs <= b.durationMs ? a : b));
    const { s, shots } = await taggedSession(ph, someReleases(video.durationMs, 2), (v) => v === video);
    await syncOk(ph, 'setup');
    const want = outcomesOf(shots);
    for (let k = start; k < 400; k += 2) {
      for (const land of [false, true]) {
        // Work for this sync: one outcome edit (PATCH), one deleted shot (DELETE), one new shot (upload + cut).
        const [edited, deleted] = [...want.keys()];
        const next = pick(OUTCOMES.filter((o) => o !== want.get(edited!)));
        await ph.backend.shots.setOutcome(s.id, edited!, next);
        want.set(edited!, next);
        await ph.backend.shots.deleteShot(s.id, deleted!);
        want.delete(deleted!);
        const outcome = pick(OUTCOMES);
        want.set((await ph.backend.shots.addShot(s.id, randInt(0, video.durationMs), outcome)).shotNumber, outcome);

        const u0 = w.proxy.counters.uploads;
        const proc = ph.platform.process;
        proc.killAtCall(k, land);
        const run = ph.backend.clips.syncNow();
        const done = await Promise.race([run, proc.died.then(() => null)]);
        const where = done ? 'uninterrupted sync' : `syncNow killed at await point ${k}, ${proc.diedAt}`;
        try {
          if (done) {
            proc.disarm();
            assert(done.errors.length === 0 && done.pending === 0, `report ${json(done)}`);
          } else {
            await ph.relaunch();
            await syncOk(ph, 'sync after the relaunch');
          }
          await checkInvariants(ph, w.laptop);
          await expectStates(ph, s.id, 'synced', 'end state');
          expectServer(s.id, A, want, 'end state');
          assert((await queuedDeletes(ph)) === 0, 'end state: clip_deletes not empty');
          await noRecordingLeft(s.id, 'end state');
          const uploads = w.proxy.counters.uploads - u0;
          assert(uploads >= 1 && uploads <= 2, `end state: ${uploads} recording uploads for one new shot (at most one extra allowed)`);
          await checkCloudInvariants([ph]);
        } catch (err) {
          throw new AssertionFailed(`${where}: ${(err as Error).message}`);
        }
        if (done) {
          assert(k > 10, `syncNow made only ${k - 1} port calls; the sweep is not reaching it`);
          return;
        }
      }
    }
    throw new AssertionFailed('sync kill sweep never reached the end of syncNow');
  },

  /** While a sync is stalled (held upload, slow API, hanging auth lookup), recording, tagging and replay stay responsive. */
  async clip_sync_responsive(w) {
    const A = CLOUD.users.A;
    for (const stall of ['upload_put', 'api_delay', 'slow_auth'] as const) {
      w.cover('stall', stall);
      const ph = await w.fresh();
      ph.auth = { kind: 'user', user: A };
      const first = await taggedSession(ph, someReleases(VIDEOS[0]!.durationMs, 2), (v) => v === VIDEOS[0]);
      const hold = deferred();
      const c0 = { ...w.proxy.counters };
      if (stall === 'upload_put') w.proxy.mode = { kind: 'stall_requests', match: /^PUT \/local-blob/, until: hold.promise };
      if (stall === 'api_delay') w.proxy.mode = { kind: 'delay', ms: 900 };
      if (stall === 'slow_auth') ph.auth = { kind: 'slow', user: A };
      let settled = false;
      const run = sync(ph).finally(() => (settled = true));
      try {
        // Wait until the sync is really held at its stall point.
        const deadline = Date.now() + 3_000;
        if (stall === 'upload_put') while (w.proxy.counters.uploads === c0.uploads && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        if (stall === 'api_delay') while (w.proxy.counters.cloudCalls === c0.cloudCalls && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        // A tag waits at most the core's auth probe (500 ms) when the token lookup is slow; otherwise it is immediate.
        const perTag = stall === 'slow_auth' ? 650 : 150;
        const t0 = Date.now();
        const s2 = await ph.recordSession(undefined, (v) => v === VIDEOS[0]);
        const tagged: number[] = [];
        for (const r of someReleases(VIDEOS[0]!.durationMs, 2)) {
          const t = Date.now();
          tagged.push((await ph.backend.shots.addShot(s2.id, r, 'made')).shotNumber);
          assert(Date.now() - t <= perTag, `${stall}: tagging a shot took ${Date.now() - t} ms during a stalled sync`);
        }
        await ph.backend.shots.setOutcome(s2.id, tagged[0]!, 'missed');
        assert((await ph.backend.sessions.replaySource(s2.id)).state === 'available', `${stall}: replay unavailable`);
        assert((await ph.backend.sessions.listWithStats()).length === 2, `${stall}: Saved Clips list wrong`);
        const total = Date.now() - t0;
        assert(total <= 2 * perTag + 400, `${stall}: recording and tagging took ${total} ms during a stalled sync`);
        if (stall !== 'slow_auth') assert(!settled, `${stall}: the sync was not actually stalled`);
      } finally {
        hold.resolve();
        w.proxy.mode = { kind: 'pass' };
      }
      await run;
      ph.auth = { kind: 'user', user: A };
      await syncOk(ph, `${stall}: sync after the stall`);
      expectServer(first.s.id, A, outcomesOf(first.shots), `${stall}: first session`);
      await expectStates(ph, first.s.id, 'synced', `${stall}: first session`);
    }
  },
};

// ---------- invariants ----------
function checkStoredPath(where: string, what: string, p: string, dir: string) {
  assert(!/^[a-z][a-z0-9+.-]*:/i.test(p), `${where}: ${what} stores a URI (${p}); SQLite must hold relative paths`);
  assert(!p.startsWith('/'), `${where}: ${what} stores an absolute path (${p}); SQLite must hold relative paths`);
  const [head, name, ...rest] = p.split('/');
  assert(
    `${head}/` === dir && name && rest.length === 0 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..'),
    `${where}: ${what} ${json(p)} is not a plain file name under ${dir}`,
  );
}

/**
 * Disk truth comes straight from node:fs and SQLite truth from a second
 * connection, so only committed rows count (what survives a kill) and an
 * adapter bug cannot hide anything.
 */
async function checkInvariants(ph: Phone, laptop: Laptop) {
  const where = ph.name;
  assert(!ph.platform.db.inTransaction(), `${where}: a transaction was left open on the app's connection`);

  const db = new DatabaseSync(ph.path('perspective.db'));
  const q = <T>(sql: string) => db.prepare(sql).all() as T[];
  try {
    const qc = q<{ quick_check: string }>('PRAGMA quick_check');
    assert(qc[0]?.quick_check === 'ok', `${where}: SQLite quick_check ${json(qc)}`);

    // Documents holds only the two app directories.
    const top = (await readdir(ph.path('Documents'))).sort();
    assert(json(top) === json(['models', 'videos']), `${where}: unexpected entries in Documents: ${top}`);

    const partials = await readdir(ph.path('Caches', 'perspective-downloads')).catch(() => []);
    assert(partials.length === 0, `${where}: leftover partial downloads ${partials}`);
    const trash = await readdir(ph.path('Caches', 'perspective-trash')).catch(() => []);
    assert(trash.length === 0, `${where}: videos left in the delete trash ${trash}`);

    // Sessions and their videos: one file per session, sizes agree, no orphans.
    const sessions = q<{ id: string; video_path: string | null; size_bytes: number | null; duration_ms: number | null; shot_type: string }>(
      'SELECT id, video_path, size_bytes, duration_ms, shot_type FROM sessions',
    );
    const referenced = new Set<string>();
    for (const s of sessions) {
      assert(typeof s.shot_type === 'string' && s.shot_type !== '', `${where}: session ${s.id} has no shot type`);
      assert(s.duration_ms === null || (s.duration_ms >= 0 && s.duration_ms <= RECORDING.maxDurationMs), `${where}: session ${s.id} duration ${s.duration_ms}`);
      if (s.video_path === null) {
        assert(s.size_bytes === null, `${where}: session ${s.id} has no video but size_bytes ${s.size_bytes}`);
        continue;
      }
      checkStoredPath(where, `session ${s.id} video_path`, s.video_path, 'videos/');
      assert(!referenced.has(s.video_path), `${where}: two sessions share ${s.video_path}`);
      referenced.add(s.video_path);
      const size = await fileSize(ph.path('Documents', ...s.video_path.split('/')));
      assert(size !== null, `${where}: missing video ${s.video_path}`);
      assert(size === Number(s.size_bytes), `${where}: ${s.video_path} is ${size} bytes, row says ${s.size_bytes}`);
    }
    const videoFiles = await readdir(ph.path('Documents', 'videos')).catch(() => []);
    const orphanVideos = videoFiles.filter((f) => !referenced.has(`videos/${f}`));
    assert(orphanVideos.length === 0, `${where}: orphan videos ${orphanVideos}`);

    // Shots belong to a session and are well formed.
    const orphanShots = q<{ session_id: string; shot_number: number }>(
      'SELECT session_id, shot_number FROM shots WHERE session_id NOT IN (SELECT id FROM sessions)',
    );
    assert(orphanShots.length === 0, `${where}: shots rows reference missing sessions: ${json(orphanShots.slice(0, 5))}`);
    const badShots = q<object>("SELECT * FROM shots WHERE shot_number < 1 OR release_ms < 0 OR outcome NOT IN ('made', 'missed', 'unmarked')");
    assert(badShots.length === 0, `${where}: malformed shots rows ${json(badShots.slice(0, 5))}`);

    // Models: one per drill and format, each row's file intact and byte-identical to the laptop export.
    const demoRows = q<{ demo_id: string; version: number; format: string; shot_type: string; local_path: string; size_bytes: number; cue: string }>(
      'SELECT demo_id, version, format, shot_type, local_path, size_bytes, cue FROM downloaded_demos',
    );
    const drills = new Map<string, number[]>();
    for (const r of demoRows) drills.set(`${r.shot_type}/${r.format}`, [...(drills.get(`${r.shot_type}/${r.format}`) ?? []), r.version]);
    for (const [drill, versions] of drills) {
      assert(versions.length === 1, `${where}: more than one model kept for ${drill}: versions ${versions.join(', ')}`);
    }
    const modelRefs = new Set<string>();
    for (const r of demoRows) {
      checkStoredPath(where, `model ${r.demo_id} v${r.version} local_path`, r.local_path, 'models/');
      assert(!modelRefs.has(r.local_path), `${where}: two model rows share ${r.local_path}`);
      modelRefs.add(r.local_path);
      const file = ph.path('Documents', ...r.local_path.split('/'));
      const size = await fileSize(file);
      assert(size !== null && size === Number(r.size_bytes) && size > 0, `${where}: model row/file mismatch ${r.local_path} (file ${size}, row ${r.size_bytes})`);
      const pub = r.demo_id === DEMO_ID ? laptop.versions.get(Number(r.version)) : undefined;
      assert(pub, `${where}: model row for something the laptop never published: ${r.demo_id} v${r.version}`);
      assert(sha(await readFile(file)) === pub.sha, `${where}: ${r.local_path} bytes differ from the laptop's v${r.version} export`);
      assert(r.cue === cueFor(Number(r.version)), `${where}: ${r.local_path} carries another version's cue: ${json(r.cue)}`);
    }
    const modelFiles = await readdir(ph.path('Documents', 'models')).catch(() => []);
    const orphanModels = modelFiles.filter((f) => !modelRefs.has(`models/${f}`));
    assert(orphanModels.length === 0, `${where}: orphan model files ${orphanModels}`);
  } finally {
    db.close();
  }
}

// ---------- main ----------
async function main() {
  await rm(ROOT, { recursive: true, force: true });
  const laptop = new Laptop(join(ROOT, 'laptop'), join(ROOT, 'laptop', 'media'), join(ROOT, 'laptop', 'demos.json'));
  await mkdir(laptop.mediaDir, { recursive: true });
  await laptop.publish();

  const t0Pool = Date.now();
  VIDEOS = await makeVideoPool(join(ROOT, 'videos'));
  console.log(`  video pool: ${VIDEOS.map((v) => `${v.durationMs} ms${v.audio ? '+audio' : ''}`).join(', ')} (${Date.now() - t0Pool} ms)`);
  const secret = randomBytes(32).toString('hex');
  const tokens = new Map<string, Promise<string>>();
  CLOUD = {
    deps: createLocalDeps(join(ROOT, 'cloud'), { jwtSecret: secret, inMemory: true }),
    users: { A: randomUUID(), B: randomUUID() },
    token: (user, ttl = 3_600) => {
      const key = `${user}/${ttl}`;
      if (!tokens.has(key)) tokens.set(key, signLocalToken(secret, user, ttl));
      return tokens.get(key)!;
    },
    sessions: new Map(),
  };
  const app = await buildApp({ catalogPath: laptop.catalogPath, mediaDir: laptop.mediaDir, deps: CLOUD.deps });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const proxy = await startFaultProxy((app.server.address() as AddressInfo).port);

  let phoneCount = 0;
  const all: Phone[] = [];
  const blank = () => {
    const ph = new Phone(`phone-${++phoneCount}`, join(ROOT, 'phones', `phone-${phoneCount}`), () => proxy.url);
    all.push(ph);
    return ph;
  };
  const mk = async (killAt?: { call: number; land: boolean }) => {
    const ph = blank();
    await ph.launch(killAt);
    return ph;
  };
  const pool = [await mk(), await mk(), await mk(), await mk()];
  const branchRuns: Record<string, Record<string, number>> = {};
  const dimCalls = new Map<string, number>();
  let current = '';
  const declared = (dim: string) => {
    const values = BRANCHES[current]?.[dim];
    if (!values) throw new Error(`harness bug: ${current} uses undeclared branch dimension ${dim}`);
    return values;
  };
  const count = (dim: string, value: string) => {
    if (!declared(dim).includes(value)) throw new Error(`harness bug: ${current} branch ${dim}:${value} is not declared`);
    branchRuns[current]![`${dim}:${value}`]!++;
  };
  const names = Object.keys(SCENARIOS);
  for (const name of names) {
    branchRuns[name] = BRANCHES[name]
      ? Object.fromEntries(Object.entries(BRANCHES[name]!).flatMap(([dim, vs]) => vs.map((v) => [`${dim}:${v}`, 0])))
      : { all: 0 };
  }
  for (const name of Object.keys(BRANCHES)) if (!SCENARIOS[name]) throw new Error(`harness bug: branches declared for unknown scenario ${name}`);

  const world: World = {
    laptop,
    proxy,
    pool,
    touched: new Set(),
    branch: (dim) => {
      const values = declared(dim);
      const key = `${current}/${dim}`;
      const n = dimCalls.get(key) ?? 0;
      dimCalls.set(key, n + 1);
      const value = values[n % values.length]!;
      count(dim, value);
      return value;
    },
    cover: (dim, value) => count(dim, value),
    fresh: async (killAt) => {
      const ph = await mk(killAt);
      world.touched.add(ph);
      return ph;
    },
    unlaunched: () => {
      const ph = blank();
      world.touched.add(ph);
      return ph;
    },
  };

  // Empty or comma-only SIM_ONLY means "all scenarios"; unknown names are an error.
  const picked = (process.env.SIM_ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = picked.filter((x) => !SCENARIOS[x]);
  if (unknown.length) throw new Error(`SIM_ONLY names unknown scenarios: ${unknown.join(', ')}`);
  const only = picked.length ? picked : null;
  const order: string[] = [];
  while (order.length < ITERATIONS) {
    const round = [...(only ?? names)].sort(() => rng() - 0.5);
    order.push(...round);
  }
  order.length = ITERATIONS;

  const stats = new Map<string, { runs: number; pass: number; fail: number; ms: number }>();
  const failures: { iteration: number; scenario: string; error: string }[] = [];
  const t0 = Date.now();

  for (let i = 0; i < order.length; i++) {
    const name = order[i]!;
    const s = stats.get(name) ?? { runs: 0, pass: 0, fail: 0, ms: 0 };
    stats.set(name, s);
    s.runs++;
    current = name;
    if (!BRANCHES[name]) branchRuns[name]!.all!++;
    world.touched = new Set(pool);
    const start = Date.now();
    let failed = false;
    try {
      await SCENARIOS[name]!(world);
      proxy.mode = { kind: 'pass' };
      for (const ph of world.touched) {
        if (ph.dead) await ph.relaunch();
        ph.freeBytesOverride = undefined;
        await checkInvariants(ph, laptop);
      }
      await checkCloudInvariants(world.touched);
      s.pass++;
    } catch (err) {
      failed = true;
      s.fail++;
      failures.push({ iteration: i + 1, scenario: name, error: (err as Error).stack ?? String(err) });
    } finally {
      // Leave the laptop and the pool healthy so one failure cannot cascade into the next scenario.
      proxy.mode = { kind: 'pass' };
      await laptop.reset();
      for (const ph of pool) {
        ph.freeBytesOverride = undefined;
        ph.auth = { kind: 'signed_out' };
        if (failed || ph.dead) await ph.relaunch().catch(() => undefined);
      }
    }
    s.ms += Date.now() - start;
    // Fresh phones are one-shot; close them to keep file handles bounded.
    for (const ph of world.touched) if (!pool.includes(ph)) await ph.close().catch(() => undefined);
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${ITERATIONS} iterations, ${failures.length} failures`);
  }

  await proxy.close();
  await app.close();
  for (const ph of pool) await ph.close();

  const total = { iterations: ITERATIONS, passed: ITERATIONS - failures.length, failed: failures.length };
  const report = {
    seed: SEED,
    durationMs: Date.now() - t0,
    ...total,
    phonesSimulated: phoneCount,
    laptopVersionsPublished: laptop.latest.version,
    httpRequestsThroughProxy: proxy.counters.requests,
    mediaDownloads: proxy.counters.mediaRequests,
    injectedDrops: proxy.counters.dropped,
    relaunches: all.reduce((n, p) => n + p.launches - 1, 0),
    scenarios: Object.fromEntries([...stats].sort().map(([k, v]) => [k, { ...v, avgMs: Math.round(v.ms / v.runs) }])),
    /** Runs per branch of every scenario; a 0 means that branch was never exercised. */
    branches: Object.fromEntries(Object.entries(branchRuns).sort(([a], [b]) => a.localeCompare(b))),
    failures,
  };
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(REPORT_FILE, JSON.stringify(report, null, 2));

  console.log(`\nseed ${SEED} · ${report.durationMs} ms · ${phoneCount} phones · ${report.relaunches} relaunches · ${report.httpRequestsThroughProxy} requests · ${report.injectedDrops} injected drops`);
  console.table(Object.fromEntries(Object.entries(report.scenarios).map(([k, v]) => [k, { runs: v.runs, pass: v.pass, fail: v.fail, avgMs: v.avgMs }])));
  for (const f of failures.slice(0, 5)) console.error(`\n#${f.iteration} ${f.scenario}\n${f.error}`);
  const unexercised = Object.entries(branchRuns).flatMap(([sc, bs]) => Object.entries(bs).filter(([, n]) => n === 0).map(([b]) => `${sc}/${b}`));
  if (unexercised.length) console.error(`\nunexercised branches: ${unexercised.join(', ')}`);
  console.log(`\n${total.passed}/${total.iterations} iterations passed`);
  if (!process.env.SIM_KEEP_SANDBOX) await rm(ROOT, { recursive: true, force: true });
  process.exitCode = failures.length ? 1 : 0;
}

await main();
