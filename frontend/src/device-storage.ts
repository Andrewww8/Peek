import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';
import { createVideoPlayer } from 'expo-video';

import { PracticeStore } from './database';
import type { DemoFiles } from './demos';
import { recoverRecordings } from './recordings';
import type { RecordingDraft } from './recordings';

const videos = new Directory(Paths.document, 'videos');
const models = new Directory(Paths.document, 'models');

function fileAt(location: string) {
  return location.startsWith('file://') ? new File(location) : new File(Paths.document, location);
}

function size(location: string) {
  const file = fileAt(location);
  return file.exists ? file.size : 0;
}

function move(source: string, destination: string) {
  fileAt(source).moveSync(fileAt(destination));
}

export function removeIfPresent(location: string) {
  const file = fileAt(location);
  if (file.exists) file.delete();
}

export function localVideoUri(path: string | null) {
  return path && size(path) > 0 ? fileAt(path).uri : null;
}

export const recordingFiles = {
  listVideos: () => videos.list().filter((entry) => entry instanceof File).map(({ name }) => name),
  size,
  move,
  remove: removeIfPresent,
};

export const demoFiles: DemoFiles = {
  size,
  availableBytes: () => Paths.availableDiskSpace,
  stage: (callback) => {
    const name = randomUUID();
    return callback(`models/${name}.partial`, `models/${name}.usdz`);
  },
  async download(url, path, onBytes, signal) {
    const task = File.createDownloadTask(url, fileAt(path), {
      sessionType: 'foreground',
      onProgress: ({ bytesWritten }) => onBytes(bytesWritten),
      signal,
    });
    await task.downloadAsync();
  },
  move,
  remove: removeIfPresent,
};

export function openModel(path: string) {
  return fileAt(path).preview({ title: 'Catch-and-shoot three' });
}

export async function loadPractice() {
  const db = await openDatabaseAsync('perspective.sqlite');
  try {
    const store = new PracticeStore(db);
    videos.create({ idempotent: true, intermediates: true });
    models.create({ idempotent: true, intermediates: true });
    recoverRecordings(recordingFiles, store);

    // A killed download may leave a temporary file or a promoted file that has no database row.
    try {
      const saved = new Set(store.listDemos().map(({ localPath }) => localPath));
      for (const file of models.list()) {
        if (file instanceof File && /^[\da-f-]{36}\.(partial|usdz)$/i.test(file.name) &&
            !saved.has(`models/${file.name}`)) file.delete();
      }
    } catch {
      // A cleanup failure does not need to prevent offline practice.
    }
    return store;
  } catch (error) {
    await db.closeAsync().catch(() => undefined);
    throw error;
  }
}

export async function inspectRecording(sourceUri: string, id: string, createdAt: number): Promise<RecordingDraft> {
  const file = new File(sourceUri);
  const sizeBytes = file.exists ? file.size : 0;
  if (!sizeBytes || !file.extension) throw new Error('The camera did not produce a usable recording.');

  const player = createVideoPlayer(null);
  let clock: ReturnType<typeof setTimeout> | undefined;
  let loaded: ReturnType<typeof player.addListener> | undefined;
  let status: ReturnType<typeof player.addListener> | undefined;
  try {
    const durationMs = await new Promise<number>((resolve, reject) => {
      const fail = () => reject(new Error('The recording could not be opened.'));
      clock = setTimeout(fail, 8_000);
      loaded = player.addListener('sourceLoad', ({ duration }) => {
        if (Number.isFinite(duration) && duration > 0) resolve(Math.ceil(duration * 1000));
      });
      status = player.addListener('statusChange', ({ status: next }) => {
        if (next === 'error') fail();
      });
      player.replaceAsync(sourceUri).catch(fail);
    });
    return { id, createdAt, durationMs, sourceUri, extension: file.extension, sizeBytes };
  } finally {
    clearTimeout(clock);
    loaded?.remove();
    status?.remove();
    player.release();
  }
}
