import { DEFAULT_SHOT_TYPE, DIRS } from './config';
import { downloadsDirUri, SESSION_VIDEO_NAME, toDocumentUri, TRASH_SEPARATOR, trashDirUri } from './paths';
import type { Platform } from './ports';

export interface RecoveryReport {
  partialDownloadsRemoved: number;
  orphanVideosRemoved: number;
  /** Clips whose save was killed between the move and the row: kept as sessions. */
  orphanVideosAdopted: number;
  /** Videos put back because the delete that trashed them never committed. */
  trashedVideosRestored: number;
  trashedVideosRemoved: number;
  orphanModelsRemoved: number;
  brokenDemoRowsRemoved: number;
  supersededDemoRowsRemoved: number;
}

/**
 * Launch-time sweep that makes disk and SQLite agree after a crash, a kill
 * mid-download, or a failed delete. Never touches a file a row references.
 */
export async function recoverStorage(p: Platform): Promise<RecoveryReport> {
  const { files, db } = p;
  const report: RecoveryReport = {
    partialDownloadsRemoved: 0,
    orphanVideosRemoved: 0,
    orphanVideosAdopted: 0,
    trashedVideosRestored: 0,
    trashedVideosRemoved: 0,
    orphanModelsRemoved: 0,
    brokenDemoRowsRemoved: 0,
    supersededDemoRowsRemoved: 0,
  };

  const tmpDir = downloadsDirUri(files);
  for (const name of await files.list(tmpDir)) {
    await files.remove(tmpDir + name);
    report.partialDownloadsRemoved++;
  }

  const videoRefs = new Set(
    (await db.all<{ video_path: string }>('SELECT video_path FROM sessions WHERE video_path IS NOT NULL')).map(
      (r) => r.video_path,
    ),
  );

  // removeVideo/deleteSession trash the file before changing the row. If the
  // row still points at it, the delete never committed: put the video back.
  // Otherwise the delete committed and the file goes for good.
  const trashDir = trashDirUri(files);
  for (const name of await files.list(trashDir)) {
    const sep = name.indexOf(TRASH_SEPARATOR);
    const videoPath = sep > 0 ? DIRS.videos + name.slice(sep + TRASH_SEPARATOR.length) : null;
    const home = videoPath ? toDocumentUri(files, videoPath) : null;
    if (videoPath && home && videoRefs.has(videoPath) && !(await files.info(home)).exists) {
      await files.ensureDir(toDocumentUri(files, DIRS.videos));
      await files.move(trashDir + name, home);
      report.trashedVideosRestored++;
    } else {
      await files.remove(trashDir + name);
      report.trashedVideosRemoved++;
    }
  }

  // An unreferenced "<uuid>.<ext>" with no session of that id is a clip whose
  // save was killed after the move and before the INSERT: keep it as a session
  // (duration unknown). If the session exists, its video was removed or
  // replaced, so the file goes. Deletes never leave files here (trash first),
  // so a deleted session cannot come back this way.
  for (const name of await files.list(toDocumentUri(files, DIRS.videos))) {
    const videoPath = DIRS.videos + name;
    if (videoRefs.has(videoPath)) continue;
    const uri = toDocumentUri(files, videoPath);
    const id = SESSION_VIDEO_NAME.exec(name)?.[1];
    if (id && !(await db.first('SELECT 1 AS x FROM sessions WHERE id = ?', [id]))) {
      const info = await files.info(uri);
      if (info.exists && info.size !== null) {
        await db.run(
          'INSERT INTO sessions (id, created_at, shot_type, video_path, duration_ms, size_bytes) VALUES (?, ?, ?, ?, NULL, ?)',
          [id, p.now(), DEFAULT_SHOT_TYPE, videoPath, info.size],
        );
        report.orphanVideosAdopted++;
        continue;
      }
    }
    await files.remove(uri);
    report.orphanVideosRemoved++;
  }

  // Same order as DemoService.findLocal: the first intact row per drill and
  // format is the current model. Older intact rows exist only when a kill
  // landed between a download's row commit and its prune; drop them here so
  // the phone keeps one model per drill. Rows go first; their files become
  // orphans for the sweep below.
  const demoRows = await db.all<{
    demo_id: string;
    version: number;
    format: string;
    shot_type: string;
    local_path: string;
    size_bytes: number;
  }>(
    `SELECT demo_id, version, format, shot_type, local_path, size_bytes FROM downloaded_demos
     ORDER BY shot_type, format, version DESC, downloaded_at DESC`,
  );
  const modelRefs = new Set<string>();
  const current = new Set<string>();
  for (const r of demoRows) {
    const info = await files.info(toDocumentUri(files, r.local_path));
    const intact = info.exists && info.size === Number(r.size_bytes);
    const drill = JSON.stringify([r.shot_type, r.format]);
    if (intact && !current.has(drill)) {
      current.add(drill);
      modelRefs.add(r.local_path);
      continue;
    }
    await db.run('DELETE FROM downloaded_demos WHERE demo_id = ? AND version = ? AND format = ?', [
      r.demo_id,
      r.version,
      r.format,
    ]);
    if (intact) report.supersededDemoRowsRemoved++;
    else report.brokenDemoRowsRemoved++;
  }
  for (const name of await files.list(toDocumentUri(files, DIRS.models))) {
    if (!modelRefs.has(DIRS.models + name)) {
      await files.remove(toDocumentUri(files, DIRS.models + name));
      report.orphanModelsRemoved++;
    }
  }
  return report;
}

export async function storageUsage(p: Platform) {
  const sum = async (dir: string) => {
    let total = 0;
    for (const name of await p.files.list(toDocumentUri(p.files, dir))) {
      total += (await p.files.info(toDocumentUri(p.files, dir + name))).size ?? 0;
    }
    return total;
  };
  return { videosBytes: await sum(DIRS.videos), modelsBytes: await sum(DIRS.models), freeBytes: await p.files.freeBytes() };
}
