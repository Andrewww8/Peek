import { DIRS } from './config';
import type { FileStore } from './ports';

/** SQLite stores paths relative to documentUri so they survive app-container moves on iOS updates. */
export const toDocumentUri = (files: FileStore, relPath: string) => files.documentUri + relPath;
export const downloadsDirUri = (files: FileStore) => files.cacheUri + DIRS.downloads;
export const trashDirUri = (files: FileStore) => files.cacheUri + DIRS.trash;

/**
 * Trash entries are "<unique>__<video file name>": unique per call because
 * expo's moveAsync deletes an existing destination first, and the original
 * name lets launch recovery put back a video whose delete never committed.
 */
export const TRASH_SEPARATOR = '__';

/** A video file name written by saveRecording: "<session uuid>.<ext>". */
export const SESSION_VIDEO_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-z0-9]{1,5}$/i;

/** Extension of a file URI, lowercased; falls back to "mov" (iOS camera default). */
export function extensionOf(uri: string): string {
  const name = uri.split(/[?#]/)[0]!.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'mov';
}

/** Only these characters reach a filename built from catalog data. */
export const isSafeSlug = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) && !s.includes('..');
