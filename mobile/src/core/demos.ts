import type { ApiClient, DemoAsset, DemoEntry } from './apiClient';
import { DIRS, FREE_SPACE_HEADROOM_BYTES, NETWORK } from './config';
import { BackendError, codeOf, type BackendErrorCode } from './errors';
import { downloadsDirUri, isSafeSlug, toDocumentUri } from './paths';
import type { Platform } from './ports';

export interface LocalDemo {
  demoId: string;
  version: number;
  format: string;
  shotType: string;
  cue: string;
  localPath: string;
  /** Absolute file URI for Quick Look. */
  uri: string;
  sizeBytes: number;
}

export interface DownloadProgress {
  bytesWritten: number;
  totalBytes: number;
}

export type OpenDemoResult =
  | {
      status: 'ready';
      demo: LocalDemo;
      /** local = opened from disk without downloading. */
      source: 'local' | 'downloaded';
      /** Set when the laptop was unreachable or a newer download failed; the last working version is shown. */
      fallback?: { code: BackendErrorCode; message: string };
    }
  | { status: 'unavailable'; code: BackendErrorCode; message: string; canRetry: true };

export interface OpenDemoOptions {
  shotType: string;
  format?: string;
  /**
   * Pin a specific catalog version instead of the newest. A pinned download
   * is a replacement like any other: once verified and saved, it becomes the
   * drill's one working model and the others, newer ones included, are
   * pruned. Keeping a newer copy would shadow the pin, because findLocal
   * opens the newest. The next unpinned open upgrades again.
   */
  version?: number;
  onProgress?: (p: DownloadProgress) => void;
}

interface DemoRow {
  demo_id: string;
  version: number;
  format: string;
  shot_type: string;
  local_path: string;
  cue: string;
  size_bytes: number;
}

export class DemoService {
  private inFlight = new Map<string, Promise<LocalDemo>>();
  /** Tail of the open queue per (shotType, format). */
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly p: Platform,
    private readonly api: ApiClient,
  ) {}

  private toLocal(r: DemoRow): LocalDemo {
    return {
      demoId: r.demo_id,
      version: Number(r.version),
      format: r.format,
      shotType: r.shot_type,
      cue: r.cue,
      localPath: r.local_path,
      uri: toDocumentUri(this.p.files, r.local_path),
      sizeBytes: Number(r.size_bytes),
    };
  }

  /** Newest downloaded demo whose file is intact. Broken rows are dropped. Works fully offline. */
  async findLocal(shotType: string, format = 'usdz'): Promise<LocalDemo | null> {
    const rows = await this.p.db.all<DemoRow>(
      'SELECT * FROM downloaded_demos WHERE shot_type = ? AND format = ? ORDER BY version DESC, downloaded_at DESC',
      [shotType, format],
    );
    for (const r of rows) {
      const demo = this.toLocal(r);
      const info = await this.p.files.info(demo.uri);
      if (info.exists && info.size === demo.sizeBytes) return demo;
      await this.p.db.run('DELETE FROM downloaded_demos WHERE demo_id = ? AND version = ? AND format = ?', [
        r.demo_id,
        r.version,
        r.format,
      ]);
      await this.p.files.remove(demo.uri);
    }
    return null;
  }

  /**
   * "View 3D Demo": local first so it opens offline; download only when the
   * model is missing or the catalog selects a newer version.
   *
   * Serialized per (shotType, format): an overlapping call waits for the one in
   * flight, then re-evaluates from scratch. Two overlapping opens that resolve
   * to different versions (a pin, or a catalog publish mid-download) would
   * otherwise each prune the other's model; now each result's file exists when
   * its call resolves, and one model is left afterwards. Repeated taps for the
   * same version still cost one download: the waiting tap finds it on disk.
   */
  openDemo(opts: OpenDemoOptions): Promise<OpenDemoResult> {
    const key = JSON.stringify([opts.shotType, opts.format ?? 'usdz']);
    const run = (this.queues.get(key) ?? Promise.resolve()).then(() => this.openDemoNow(opts));
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  private async openDemoNow(opts: OpenDemoOptions): Promise<OpenDemoResult> {
    const format = opts.format ?? 'usdz';
    const local = await this.findLocal(opts.shotType, format);

    let catalog: DemoEntry[];
    try {
      catalog = await this.api.listDemos(opts.shotType);
    } catch (err) {
      return this.fallback(local, err);
    }

    const candidates = catalog
      .filter((e) => e.assets.some((a) => a.format === format))
      .filter((e) => opts.version === undefined || e.version === opts.version)
      .sort((a, b) => b.version - a.version || a.id.localeCompare(b.id));
    const entry = candidates[0];
    if (!entry) {
      if (local && opts.version === undefined) return { status: 'ready', demo: local, source: 'local' };
      return this.fallback(local, new BackendError('not_found', 'No 3D demo published for this drill yet'));
    }

    if (
      local &&
      local.demoId === entry.id &&
      (local.version === entry.version || (opts.version === undefined && local.version > entry.version))
    ) {
      // The catalog confirms the local model is current: drop any older copy a
      // failed or interrupted prune left behind (best effort, like the download path).
      await this.pruneOlder(local.demoId, local.shotType, local.format, local.version).catch(() => undefined);
      return { status: 'ready', demo: local, source: 'local' };
    }

    const asset = entry.assets.find((a) => a.format === format)!;
    try {
      const demo = await this.download(entry, asset, opts.onProgress);
      return { status: 'ready', demo, source: 'downloaded' };
    } catch (err) {
      return this.fallback(local, err);
    }
  }

  private fallback(local: LocalDemo | null, err: unknown): OpenDemoResult {
    const code = codeOf(err);
    const message = (err as Error)?.message ?? String(err);
    return local
      ? { status: 'ready', demo: local, source: 'local', fallback: { code, message } }
      : { status: 'unavailable', code, message, canRetry: true };
  }

  /** Concurrent taps share one download. */
  private download(entry: DemoEntry, asset: DemoAsset, onProgress?: (p: DownloadProgress) => void) {
    const key = `${entry.id}@${entry.version}.${asset.format}`;
    let job = this.inFlight.get(key);
    if (!job) {
      job = this.doDownload(entry, asset, onProgress).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, job);
    }
    return job;
  }

  private async doDownload(
    entry: DemoEntry,
    asset: DemoAsset,
    onProgress?: (p: DownloadProgress) => void,
  ): Promise<LocalDemo> {
    const { files, db } = this.p;
    if (!isSafeSlug(entry.id)) throw new BackendError('invalid_catalog', `Unsafe demo id ${entry.id}`);

    const free = await files.freeBytes();
    if (free < asset.sizeBytes + FREE_SPACE_HEADROOM_BYTES) {
      throw new BackendError('insufficient_space', `Need ${asset.sizeBytes} bytes plus headroom; ${free} free`);
    }

    const url = this.api.resolveAssetUrl(asset.url);
    const tmpDir = downloadsDirUri(files);
    await files.ensureDir(tmpDir);
    const tmp = `${tmpDir}${entry.id}-v${entry.version}.${asset.format}.${this.p.newId()}.part`;
    const localPath = `${DIRS.models}${entry.id}-v${entry.version}.${asset.format}`;
    const dest = toDocumentUri(files, localPath);

    try {
      let status: number;
      try {
        ({ status } = await files.download(url, tmp, {
          timeoutMs: NETWORK.downloadTimeoutMs,
          maxBytes: asset.sizeBytes,
          onProgress: (bytesWritten) => onProgress?.({ bytesWritten, totalBytes: asset.sizeBytes }),
        }));
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        if (message.includes('exceeded maxBytes')) {
          throw new BackendError('size_mismatch', `Expected ${asset.sizeBytes} bytes, server sent more (${message})`);
        }
        throw new BackendError('download_failed', `Download interrupted: ${message}`);
      }
      if (status !== 200) throw new BackendError('http_error', `HTTP ${status} downloading ${url}`);

      const got = await files.info(tmp);
      if (got.size !== asset.sizeBytes) {
        throw new BackendError('size_mismatch', `Expected ${asset.sizeBytes} bytes, got ${got.size ?? 0}`);
      }

      await files.ensureDir(toDocumentUri(files, DIRS.models));
      await files.remove(dest);
      await files.move(tmp, dest);
      await db.run(
        `INSERT OR REPLACE INTO downloaded_demos
           (demo_id, version, format, shot_type, local_path, cue, size_bytes, downloaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.version, asset.format, entry.shotType, localPath, entry.cue, asset.sizeBytes, this.p.now()],
      );
    } finally {
      await files.remove(tmp);
    }

    // The new model is committed. A failed prune must not fail the open: the
    // caller would fall back to an old row it may already have deleted. Rows
    // go before files, so whatever is left over is an orphan the launch sweep removes.
    await this.pruneOlder(entry.id, entry.shotType, asset.format, entry.version).catch(() => undefined);
    return {
      demoId: entry.id,
      version: entry.version,
      format: asset.format,
      shotType: entry.shotType,
      cue: entry.cue,
      localPath,
      uri: dest,
      sizeBytes: asset.sizeBytes,
    };
  }

  /** Only after a verified replacement is saved do older versions get removed. */
  private async pruneOlder(demoId: string, shotType: string, format: string, keepVersion: number) {
    const old = await this.p.db.all<DemoRow>(
      `SELECT * FROM downloaded_demos
       WHERE shot_type = ? AND format = ? AND NOT (demo_id = ? AND version = ?)`,
      [shotType, format, demoId, keepVersion],
    );
    for (const r of old) {
      await this.p.db.run('DELETE FROM downloaded_demos WHERE demo_id = ? AND version = ? AND format = ?', [
        r.demo_id,
        r.version,
        r.format,
      ]);
      await this.p.files.remove(toDocumentUri(this.p.files, r.local_path));
    }
  }
}
