/**
 * Test helpers: generate small synthetic recordings with ffmpeg's lavfi sources
 * and measure clips without ffprobe (ffmpeg-static ships only ffmpeg). Each
 * frame's luma is 2 × its frame number, so the first frame of a clip tells
 * which source frame the cut started on.
 */
import { spawn } from 'node:child_process';
import { ffmpegPath, runFfmpeg } from './ffmpeg.js';

export const FFMPEG = ffmpegPath();

export async function makeVideo(file: string, o: { seconds: number; fps: number; audio: boolean }): Promise<void> {
  const video = `color=c=black:s=64x48:r=${o.fps}:d=${o.seconds},format=gray,geq=lum='min(N*2\\,255)':cb=128:cr=128,format=yuv420p`;
  const args = ['-y', '-f', 'lavfi', '-i', video];
  if (o.audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${o.seconds}`);
  args.push('-c:v', 'libx264', '-crf', '5', '-g', String(o.fps), '-pix_fmt', 'yuv420p');
  if (o.audio) args.push('-c:a', 'aac', '-shortest');
  args.push('-t', String(o.seconds), file);
  const r = await runFfmpeg(FFMPEG, args);
  if (r.code !== 0) throw new Error(`could not make test video: ${r.stderr}`);
}

export interface VideoInfo {
  frames: number;
  durationMs: number;
  videoCodec: string | null;
  audioCodec: string | null;
  firstLuma: number;
}

function firstFrameLuma(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)[0] ?? -1));
  });
}

export async function videoInfo(file: string): Promise<VideoInfo> {
  const { stderr } = await runFfmpeg(FFMPEG, ['-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-']);
  const frames = [...stderr.matchAll(/frame=\s*(\d+)/g)].pop()?.[1];
  const d = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  return {
    frames: Number(frames ?? 0),
    durationMs: d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) : 0,
    videoCodec: /Stream #0:\d+.*: Video: (\w+)/.exec(stderr)?.[1] ?? null,
    audioCodec: /Stream #0:\d+.*: Audio: (\w+)/.exec(stderr)?.[1] ?? null,
    firstLuma: await firstFrameLuma(file),
  };
}
