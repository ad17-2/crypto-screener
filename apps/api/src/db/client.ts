import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ensureSchema } from './schema.js';

/**
 * `foreign_keys` forced OFF: better-sqlite3 defaults it ON, but backfills write factor_history
 * rows with no matching `runs` row — the pragma on would make those inserts fail.
 */
export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  ensureSchema(db);
  return db;
}

/** Builds a `?,?,...` placeholder list of the given length for a SQL `IN (...)` clause. */
export function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}
