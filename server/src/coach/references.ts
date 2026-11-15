import { readFile } from 'node:fs/promises';
import { buildTemplateRecord, type TemplateRecord } from '../cv/templates.js';
import type { ReferenceRepo } from './deps.js';

const curry = 'Stephen Curry';
const curryFiles = new Map([
  ['three_point', 'Stephen_Curry_three.npz'],
  ['midrange', 'Stephen_Curry_midrange.npz'],
]);
const bundledCurry = new Map<string, Promise<TemplateRecord>>();

/** Use the database library and fill in Curry from the release bundle when he is missing. */
export async function listCoachTemplates(references: ReferenceRepo, shotType: string): Promise<TemplateRecord[]> {
  const file = curryFiles.get(shotType);
  if (!file) return references.listTemplates(shotType);

  // An empty or temporarily unavailable template table still allows a Curry comparison.
  const stored = await references.listTemplates(shotType).catch(() => []);
  if (stored.some((template) => template.player === curry)) return stored;

  let fallback = bundledCurry.get(file);
  if (!fallback) {
    fallback = readFile(new URL(`../../reference-data/average-shots/${file}`, import.meta.url))
      .then((bytes) => buildTemplateRecord(bytes, file))
      .catch((error: unknown) => {
        bundledCurry.delete(file);
        throw error;
      });
    bundledCurry.set(file, fallback);
  }
  return [...stored, await fallback];
}

export function findProTemplate(templates: readonly TemplateRecord[], player: string) {
  const name = player.trim().toLowerCase().replace(/['’]s$/, '').replace(/\s+/g, ' ');
  const canonical = name === 'steph' || name === 'steph curry' ? curry.toLowerCase() : name;
  return templates.find((template) => template.player.toLowerCase() === canonical)
    ?? templates.find((template) => template.player.toLowerCase().split(' ').includes(canonical));
}
