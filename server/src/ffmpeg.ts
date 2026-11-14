/** Trimmer backed by the ffmpeg binary from ffmpeg-static (or FFMPEG_PATH). */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Trimmer } from './deps.js';

export function ffmpegPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FFMPEG_PATH) return env.FFMPEG_PATH;
  const path = createRequire(import.meta.url)('ffmpeg-static') as string | null;
  if (!path) throw new Error('ffmpeg-static has no binary for this platform; set FFMPEG_PATH');
  return path;
}

/** Runs ffmpeg and resolves with its stderr (where it reports stream info and progress). */
export function runFfmpeg(bin: string, args: string[], timeoutMs = 240_000): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-64_000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

/** `Duration: 00:00:04.00` from ffmpeg's input summary, in ms. */
export function parseDurationMs(stderr: string): number | null {
  const m = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);
/**
 * Recordings are always MOV/MP4. Forcing that demuxer stops ffmpeg from guessing
 * another format from the bytes (junk probes as CD+G, and playlist-style
 * demuxers such as HLS or concat could make ffmpeg read other files).
 */
const INPUT = ['-f', 'mov'];

export function createFfmpegTrimmer(bin: string = ffmpegPath()): Trimmer {
  return {
    async probeDurationMs(input) {
      // With no output ffmpeg exits 1 after printing the input summary; that is expected.
      const { stderr } = await runFfmpeg(bin, [...INPUT, '-i', input]);
      const ms = parseDurationMs(stderr);
      if (ms === null || ms <= 0 || !/Stream #\d+:\d+.*: Video:/.test(stderr)) {
        throw new Error(`not a readable video: ${stderr.split('\n').slice(-3).join(' ')}`);
      }
      return ms;
    },

    async trim(input, startMs, endMs, output) {
      if (!(endMs > startMs)) throw new Error(`empty clip window ${startMs}-${endMs}`);
      const { code, stderr } = await runFfmpeg(bin, [
        '-y',
        ...INPUT,
        '-i', input,
        // -ss after -i decodes up to the start instead of jumping to a keyframe: frame-accurate.
        '-ss', seconds(startMs),
        '-t', seconds(endMs - startMs),
        '-map', '0:v:0',
        '-map', '0:a:0?', // the trailing ? keeps recordings without an audio track working
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-f', 'mp4',
        output,
      ]);
      if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.split('\n').slice(-5).join(' ')}`);
    },
  };
}
