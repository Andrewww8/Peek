/**
 * Calibrates the coach from the averaged pro shot templates: per shot type, weighted
 * mean / sd / min / max of every pro-comparable metric, plus curve scales. Writes the
 * committed src/coach/pro-baselines.generated.ts, which also drives the numbers in the
 * form skills (src/coach/skill.ts). Deterministic.
 *
 *   npm run calibrate-coach -w server [-- <dir>]
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { calibrate, renderBaselinesModule } from '../src/coach/calibration.js';
import { buildTemplateRecord } from '../src/cv/templates.js';

export const DEFAULT_TEMPLATE_DIR = join(import.meta.dirname, '..', 'reference-data', 'average-shots');
export const GENERATED_FILE = join(import.meta.dirname, '..', 'src', 'coach', 'pro-baselines.generated.ts');

export async function loadTemplateRecords(dir = DEFAULT_TEMPLATE_DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.npz')).sort();
  return Promise.all(files.map(async (f) => buildTemplateRecord(await readFile(join(dir, f)), f)));
}

export async function renderCalibration(dir = DEFAULT_TEMPLATE_DIR): Promise<string> {
  const records = await loadTemplateRecords(dir);
  return renderBaselinesModule(calibrate(records), records.map((r) => r.sourceFile));
}

if (import.meta.filename === process.argv[1]) {
  const out = await renderCalibration(process.argv[2] ?? DEFAULT_TEMPLATE_DIR);
  await writeFile(GENERATED_FILE, out);
  console.log(`wrote ${GENERATED_FILE}`);
}
