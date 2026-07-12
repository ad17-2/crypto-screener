import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/client.js';
import { formatJakartaIso } from '../../src/db/time.js';

export interface TempDb {
  dir: string;
  dbPath: string;
  db: Database.Database;
}

/** Creates a fresh temp directory under the OS tmpdir, prefixed for easy identification. */
export function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Removes a temp directory created by createTempDir (and everything inside it). */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Creates a fresh temp dir + `screener.sqlite3` path inside it, opened via openDatabase(). */
export function setupTempDb(prefix: string): TempDb {
  const dir = createTempDir(prefix);
  const dbPath = join(dir, 'screener.sqlite3');
  const db = openDatabase(dbPath);
  return { dir, dbPath, db };
}

/** Closes db and removes the temp directory created by setupTempDb. */
export function teardownTempDb(dir: string, db: Database.Database): void {
  db.close();
  removeTempDir(dir);
}

/** Formats the instant `hours` before `reference` as a Jakarta-offset ISO string. */
export function hoursAgo(reference: Date, hours: number): string {
  return formatJakartaIso(new Date(reference.getTime() - hours * 3_600_000));
}
