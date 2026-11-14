/**
 * Upserts every averaged pro shot template into reference_templates (one row per player and
 * shot type), with its metrics, curves and compact template. Idempotent: re-running updates rows.
 * Uses the same deps as the server: local stand-ins by default, production (service role)
 * when PERSPECTIVE_DEPS=production or on Vercel.
 *
 *   npm run reference-templates-ingest -w server [-- <dir>]     (default: reference-data/average-shots)
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReferenceRepo } from '../src/coach/deps.js';
import { buildTemplateRecord } from '../src/cv/templates.js';

export const DEFAULT_TEMPLATE_DIR = join(import.meta.dirname, '..', 'reference-data', 'average-shots');

export async function ingestTemplates(references: ReferenceRepo, dir = DEFAULT_TEMPLATE_DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.npz')).sort();
  const out: { file: string; player: string; shotType: string; shotsAveraged: number; flags: string[] }[] = [];
  for (const f of files) {
    const t = buildTemplateRecord(await readFile(join(dir, f)), f);
    await references.upsertTemplate(t);
    out.push({ file: f, player: t.player, shotType: t.shotType, shotsAveraged: t.shotsAveraged, flags: [...(t.lowConfidence ? ['low_confidence'] : []), ...(t.uncertainDistance ? ['uncertain_distance'] : [])] });
  }
  return out;
}

if (import.meta.filename === process.argv[1]) {
  const { depsFromEnv } = await import('../src/env.js');
  const deps = depsFromEnv(process.env);
  const done = await ingestTemplates(deps.references!, process.argv[2] ?? DEFAULT_TEMPLATE_DIR);
  for (const t of done) console.log(`${t.player.padEnd(26)} ${t.shotType.padEnd(12)} ${String(t.shotsAveraged).padStart(3)} shots ${t.flags.join(' ')}`);
  console.log(`upserted ${done.length} templates`);
}
