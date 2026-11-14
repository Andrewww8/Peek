import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';

import { PracticeStore } from '../src/database.ts';
import type { PracticeDatabase } from '../src/database.ts';
import type { DemoFiles } from '../src/demos.ts';

export function environment(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'perspective-test-'));
  const connections = new Set<DatabaseSync>();
  const path = (file: string) => join(root, file);
  mkdirSync(path('videos'));
  mkdirSync(path('models'));

  t.after(() => {
    for (const db of connections) db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function open(prepare?: (db: DatabaseSync) => void) {
    const db = new DatabaseSync(path('test.sqlite'));
    connections.add(db);
    prepare?.(db);
    const adapter: PracticeDatabase = {
      execSync: (sql) => db.exec(sql),
      runSync: (sql, ...args) => db.prepare(sql).run(...args),
      getFirstSync: <T>(sql: string, ...args: (string | number | null)[]) => {
        const row = db.prepare(sql).get(...args);
        return row ? { ...row } as T : null;
      },
      getAllSync: <T>(sql: string, ...args: (string | number | null)[]) =>
        db.prepare(sql).all(...args).map((row) => ({ ...row }) as T),
    };
    return {
      store: new PracticeStore(adapter),
      close() {
        db.close();
        connections.delete(db);
      },
    };
  }

  const files = {
    listVideos: () => readdirSync(path('videos')),
    size: (file: string) => existsSync(path(file)) ? statSync(path(file)).size : 0,
    move: (from: string, to: string) => renameSync(path(from), path(to)),
    remove: (file: string) => rmSync(path(file), { force: true }),
  };
  const demoFiles: DemoFiles = {
    ...files,
    availableBytes: () => 100_000_000,
    stage: (callback) => {
      const id = randomUUID();
      return callback(`models/${id}.partial`, `models/${id}.usdz`);
    },
    async download(url, file, onBytes, signal) {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      writeFileSync(path(file), bytes);
      onBytes(bytes.length);
    },
  };
  return { open, files, demoFiles, path };
}
