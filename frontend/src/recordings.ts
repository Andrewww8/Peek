import { RECORD_LIMIT_SECONDS, RECORD_MAX_BYTES, SHOT_TYPE, STORAGE_RESERVE_BYTES } from './practice.ts';
import type { Session } from './practice.ts';

const videoDirectory = 'videos';
const filenamePattern = /^([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})-(\d+)-(\d+)\.[a-z\d]{1,8}$/i;

export const RECORDING_FREE_BYTES = RECORD_MAX_BYTES + STORAGE_RESERVE_BYTES;

// A 30-second clip's container often ends a frame or two past 30 s. The API accepts up to 500 ms more.
const durationToleranceMs = 500;

export function checkImportDuration(durationMs: number) {
  if (durationMs > RECORD_LIMIT_SECONDS * 1000 + durationToleranceMs) {
    throw new Error(`Choose a video up to ${RECORD_LIMIT_SECONDS} seconds long.`);
  }
}

export type RecordingDraft = Omit<Session, 'shotType' | 'videoPath'> & {
  sourceUri: string;
  extension: string;
};

type RecordingFiles = {
  listVideos(): string[];
  size(location: string): number;
  move(source: string, destination: string): void;
  remove(location: string): void;
};

type Sessions = {
  getSession(id: string): Session | null;
  saveSession(session: Session, cloudUserId?: string | null): void;
  clearVideo(id: string): void;
};

function recordingPath(draft: RecordingDraft) {
  const filename = `${draft.id}-${draft.createdAt}-${draft.durationMs}${draft.extension}`;
  if (!filenamePattern.test(filename)) throw new Error('The recording filename is invalid.');
  return `${videoDirectory}/${filename}`;
}

export function saveRecording(draft: RecordingDraft, files: RecordingFiles, sessions: Sessions, cloudUserId: string | null = null) {
  const existing = sessions.getSession(draft.id);
  if (existing) return existing;

  const videoPath = recordingPath(draft);
  if (files.size(videoPath) !== draft.sizeBytes) {
    if (draft.sizeBytes <= 0 || files.size(draft.sourceUri) !== draft.sizeBytes) {
      throw new Error('The completed recording could not be found.');
    }
    files.move(draft.sourceUri, videoPath);
  }
  const session: Session = {
    id: draft.id,
    createdAt: draft.createdAt,
    shotType: SHOT_TYPE,
    videoPath,
    durationMs: draft.durationMs,
    sizeBytes: draft.sizeBytes,
  };
  sessions.saveSession(session, cloudUserId);
  return session;
}

export function recoverRecordings(files: RecordingFiles, sessions: Sessions) {
  for (const filename of files.listVideos()) {
    const match = filenamePattern.exec(filename);
    if (!match) continue;

    const [, id, createdAt, durationMs] = match;
    if (!id || !createdAt || !durationMs || sessions.getSession(id)) continue;

    const videoPath = `${videoDirectory}/${filename}`;
    const sizeBytes = files.size(videoPath);
    const date = Number(createdAt);
    const duration = Number(durationMs);
    if (sizeBytes <= 0 || !Number.isSafeInteger(date) || date > 8.64e15 ||
        !Number.isSafeInteger(duration) || duration <= 0) continue;

    sessions.saveSession({
      id, createdAt: date, shotType: SHOT_TYPE, videoPath, durationMs: duration, sizeBytes,
    });
  }
}

export function removeRecording(session: Session, files: RecordingFiles, sessions: Sessions) {
  if (session.videoPath) files.remove(session.videoPath);
  sessions.clearVideo(session.id);
}
