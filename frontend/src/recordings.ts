import { RECORD_MAX_BYTES, SHOT_TYPE, STORAGE_RESERVE_BYTES } from './practice.ts';
import type { Session } from './practice.ts';

const videoDirectory = 'videos';
const filenamePattern = /^([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})-(\d+)-(\d+)\.[a-z\d]{1,8}$/i;

export const RECORDING_FREE_BYTES = RECORD_MAX_BYTES + STORAGE_RESERVE_BYTES;

export type RecordingDraft = Omit<Session, 'shotType' | 'videoPath'> & {
  sourceUri: string;
  extension: string;
};

export type FootageDecision = 'save' | 'discard';

type RecordingFiles = {
  listVideos(): string[];
  size(location: string): number;
  move(source: string, destination: string): void;
  remove(location: string): void;
};

type Sessions = {
  getSession(id: string): Session | null;
  saveSession(session: Session, cloudUserId?: string | null): void;
  isRecordingDiscarded(id: string): boolean;
};

function recordingPath(draft: RecordingDraft) {
  const filename = `${draft.id}-${draft.createdAt}-${draft.durationMs}${draft.extension}`;
  if (!filenamePattern.test(filename)) throw new Error('The recording filename is invalid.');
  return `${videoDirectory}/${filename}`;
}

export function saveRecording(draft: RecordingDraft, files: RecordingFiles, sessions: Sessions, cloudUserId: string | null = null) {
  if (sessions.isRecordingDiscarded(draft.id)) throw new Error('This recording was discarded.');
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
  const saved = sessions.getSession(draft.id);
  if (!saved) throw new Error('This recording could not be saved.');
  return saved;
}

function removeDiscardedFile(path: string, files: RecordingFiles) {
  try { files.remove(path); } catch { /* Recovery retries cleanup for discarded recording IDs. */ }
}

export async function saveConfirmedRecording(
  draft: RecordingDraft, files: RecordingFiles, sessions: Sessions & { discardSession(id: string): void },
  confirm: () => Promise<FootageDecision>, cloudUserId: string | null = null,
) {
  if (await confirm() === 'save') return saveRecording(draft, files, sessions, cloudUserId);
  sessions.discardSession(draft.id);
  removeDiscardedFile(recordingPath(draft), files);
  return null;
}

export function recoverRecordings(files: RecordingFiles, sessions: Sessions) {
  for (const filename of files.listVideos()) {
    const match = filenamePattern.exec(filename);
    if (!match) continue;

    const [, id, createdAt, durationMs] = match;
    if (!id || !createdAt || !durationMs) continue;
    const videoPath = `${videoDirectory}/${filename}`;
    if (sessions.isRecordingDiscarded(id)) {
      removeDiscardedFile(videoPath, files);
      continue;
    }
    if (sessions.getSession(id)) continue;
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

export function removeRecording(session: Session, files: RecordingFiles, sessions: { clearVideo(id: string): void }) {
  if (session.videoPath) files.remove(session.videoPath);
  sessions.clearVideo(session.id);
}
