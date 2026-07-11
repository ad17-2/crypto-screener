import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { RunPayload } from '../pipeline/models.js';
import { renderCsv } from './csv.js';
import { renderJson } from './json.js';
import { renderMarkdown } from './markdown.js';

/**
 * Assumes `generated_at` is Jakarta-local ISO-8601 with an explicit offset (formatJakartaIso).
 * Deliberately not shared with runPipeline.ts's similar-looking run_id stamp -- do not dedupe them.
 */
function compactJakartaStamp(generatedAtIso: string): string {
  const [datePart, timePart] = generatedAtIso.slice(0, 19).split('T');
  return `${(datePart ?? '').replace(/-/g, '')}-${(timePart ?? '').replace(/:/g, '')}`;
}

/** Return key order (json/csv/markdown) matters -- cli/screener.ts's stdout contract iterates these keys directly. */
export function writeReports(
  payload: RunPayload,
  config: AppConfig,
  outDir: string,
): Record<string, string> {
  mkdirSync(outDir, { recursive: true });
  const stem = `crypto-quant-daily-${compactJakartaStamp(payload.generated_at)}`;

  const jsonPath = join(outDir, `${stem}.json`);
  const csvPath = join(outDir, `${stem}.csv`);
  const mdPath = join(outDir, `${stem}.md`);

  writeFileSync(jsonPath, renderJson(payload), 'utf-8');
  writeFileSync(csvPath, renderCsv(payload.rows), 'utf-8');
  writeFileSync(mdPath, renderMarkdown(payload, config), 'utf-8');

  return { json: jsonPath, csv: csvPath, markdown: mdPath };
}
