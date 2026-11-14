import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipWindow } from './deps.js';
import { createFfmpegTrimmer, parseDurationMs } from './ffmpeg.js';
import { makeVideo, videoInfo } from './test-video.js';

const FPS = 20; // 50 ms per frame; luma = 2 × frame number up to frame 127
const SECONDS = 6;

let dir: string;
let withAudio: string;
let silent: string;
const trimmer = createFfmpegTrimmer();

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perspective-ffmpeg-'));
  withAudio = join(dir, 'with-audio.mp4');
  silent = join(dir, 'silent.mov');
  await makeVideo(withAudio, { seconds: SECONDS, fps: FPS, audio: true });
  await makeVideo(silent, { seconds: SECONDS, fps: FPS, audio: false });
});
after(() => rm(dir, { recursive: true, force: true }));

describe('ffmpeg trimmer', () => {
  test('parses the container duration', () => {
    assert.equal(parseDurationMs('  Duration: 00:00:04.00, start: 0.000000'), 4000);
    assert.equal(parseDurationMs('  Duration: 00:01:02.345, start'), 62345);
    assert.equal(parseDurationMs('no duration here'), null);
  });

  test('probes the duration of mp4 and mov inputs, with and without audio', async () => {
    assert.equal(await trimmer.probeDurationMs(withAudio), SECONDS * 1000);
    assert.equal(await trimmer.probeDurationMs(silent), SECONDS * 1000);
  });

  test('rejects files that are not videos', async () => {
    const junk = join(dir, 'junk.mov');
    await writeFile(junk, Buffer.alloc(4096, 7));
    await assert.rejects(trimmer.probeDurationMs(junk));
    await assert.rejects(trimmer.probeDurationMs(join(dir, 'missing.mov')));
  });

  // releaseMs -> window: interior, clamped at the start, clamped at the end, release exactly at the end.
  const cases = [
    { name: 'interior window', releaseMs: 4000 },
    { name: 'start clamped to 0', releaseMs: 1000 },
    { name: 'end clamped to the duration', releaseMs: 5800 },
    { name: 'release at the very end', releaseMs: SECONDS * 1000 },
    { name: 'release at 0', releaseMs: 0 },
  ];
  for (const input of ['with-audio.mp4', 'silent.mov']) {
    for (const c of cases) {
      test(`${input}: ${c.name} is cut to within one frame, H.264${input.startsWith('with') ? '/AAC' : ''}`, async () => {
        const { startMs, endMs } = clipWindow(c.releaseMs, SECONDS * 1000);
        const out = join(dir, `${input}-${c.releaseMs}.mp4`);
        await trimmer.trim(join(dir, input), startMs, endMs, out);
        const info = await videoInfo(out);
        const expectedFrames = Math.round(((endMs - startMs) * FPS) / 1000);
        assert.ok(Math.abs(info.frames - expectedFrames) <= 1, `${info.frames} frames, expected ${expectedFrames} (${startMs}-${endMs} ms)`);
        assert.ok(Math.abs(info.durationMs - (endMs - startMs)) <= 1000 / FPS + 30, `duration ${info.durationMs} ms vs ${endMs - startMs}`);
        const startFrame = Math.round((startMs * FPS) / 1000);
        assert.ok(Math.abs(info.firstLuma - 2 * startFrame) <= 3, `first frame luma ${info.firstLuma}: cut started near frame ${info.firstLuma / 2}, expected ${startFrame}`);
        assert.equal(info.videoCodec, 'h264');
        assert.equal(info.audioCodec, input.startsWith('with') ? 'aac' : null);
      });
    }
  }

  test('refuses an empty window', async () => {
    await assert.rejects(trimmer.trim(withAudio, 1000, 1000, join(dir, 'empty.mp4')), /empty clip window/);
  });
});

describe('ffmpeg input hardening', () => {
  test('uploads that are playlists or concat lists are not followed', async () => {
    const hls = join(dir, 'playlist.mov');
    await writeFile(hls, `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nfile://${withAudio}\n#EXT-X-ENDLIST\n`);
    await assert.rejects(trimmer.probeDurationMs(hls));
    const concat = join(dir, 'concat.mov');
    await writeFile(concat, `ffconcat version 1.0\nfile '${withAudio}'\n`);
    await assert.rejects(trimmer.probeDurationMs(concat));
  });
});
