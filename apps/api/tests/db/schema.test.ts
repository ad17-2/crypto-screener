import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/client.js';
import { ensureSchema } from '../../src/db/schema.js';
import { createTempDir, removeTempDir } from '../support/tempDb.js';

const EXPECTED_TABLES = [
  'runs',
  'market_rows',
  'factor_history',
  'market_regime_history',
  'recommendations',
];
const EXPECTED_INDEXES = [
  'idx_market_rows_symbol_time',
  'idx_market_rows_time',
  'idx_factor_history_symbol_time',
  'idx_factor_history_time',
  'idx_market_regime_history_time',
  'idx_recommendations_symbol_time',
];

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = createTempDir('crypto-screener-db-');
  dbPath = join(dir, 'nested', 'screener.sqlite3');
});

afterEach(() => {
  removeTempDir(dir);
});

describe('openDatabase / ensureSchema', () => {
  it('creates the parent directory and all tables/indexes on first open', () => {
    const db = openDatabase(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);

      const tableNames = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const table of EXPECTED_TABLES) {
        expect(tableNames).toContain(table);
      }

      const indexNames = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const index of EXPECTED_INDEXES) {
        expect(indexNames).toContain(index);
      }
    } finally {
      db.close();
    }
  });

  it("disables foreign_keys and enables WAL, matching Python's never-enabled FK behavior", () => {
    const db = openDatabase(dbPath);
    try {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(0);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('is idempotent: reopening an existing database does not lose data or error', () => {
    const first = openDatabase(dbPath);
    first
      .prepare(
        `INSERT INTO runs (run_id, generated_at, config_json, context_json, provider_status_json)
         VALUES (?, ?, '{}', '{}', '{}')`,
      )
      .run('run-1', '2026-07-01T00:00:00+07:00');
    first.close();

    const second = openDatabase(dbPath);
    try {
      const row = second.prepare('SELECT run_id FROM runs WHERE run_id = ?').get('run-1');
      expect(row).toEqual({ run_id: 'run-1' });
      expect(() => ensureSchema(second)).not.toThrow();
    } finally {
      second.close();
    }
  });

  it('adds missing legacy columns (regime_json, factor_weights_json) to an old-schema runs table', () => {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          generated_at TEXT NOT NULL,
          config_json TEXT NOT NULL,
          context_json TEXT NOT NULL,
          provider_status_json TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO runs (run_id, generated_at, config_json, context_json, provider_status_json)
       VALUES ('legacy-run', '2026-01-01T00:00:00+07:00', '{}', '{}', '{}')`,
    ).run();

    const columnsBefore = db
      .prepare('PRAGMA table_info(runs)')
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columnsBefore).not.toContain('regime_json');
    expect(columnsBefore).not.toContain('factor_weights_json');

    ensureSchema(db);

    const columnsAfter = db
      .prepare('PRAGMA table_info(runs)')
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columnsAfter).toContain('regime_json');
    expect(columnsAfter).toContain('factor_weights_json');

    const legacyRow = db
      .prepare('SELECT regime_json, factor_weights_json FROM runs WHERE run_id = ?')
      .get('legacy-run') as { regime_json: string; factor_weights_json: string };
    expect(legacyRow.regime_json).toBe('{}');
    expect(legacyRow.factor_weights_json).toBe('{}');

    db.close();
  });
});
