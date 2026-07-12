import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadLatestRegimeState,
  loadRegimeStates,
  recordRegimeHistory,
} from '../../src/db/regimeHistory.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  ({ dir, db } = setupTempDb('crypto-screener-regime-'));
});

afterEach(() => {
  teardownTempDb(dir, db);
});

describe('recordRegimeHistory', () => {
  it('appends (does not upsert): two calls for the same run_id produce two rows', () => {
    recordRegimeHistory(db, {
      run_id: 'run-1',
      generated_at: '2026-07-01T00:00:00+07:00',
      regime: { regime_state: 'risk-on' },
    });
    recordRegimeHistory(db, {
      run_id: 'run-1',
      generated_at: '2026-07-01T00:00:00+07:00',
      regime: { regime_state: 'risk-off' },
    });

    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM market_regime_history').get() as { count: number }
    ).count;
    expect(count).toBe(2);
  });

  it('falls back regime_state to regime.label, and eth_btc_performance_pct to regime.eth_btc_performance_pct', () => {
    recordRegimeHistory(db, {
      run_id: 'run-1',
      generated_at: '2026-07-01T00:00:00+07:00',
      market_context: { btc_dominance_pct: 55.5 },
      regime: { label: 'neutral', eth_btc_performance_pct: 1.25 },
    });

    const row = db
      .prepare(
        'SELECT btc_dominance_pct, eth_btc_performance_pct, regime_state FROM market_regime_history WHERE run_id = ?',
      )
      .get('run-1') as {
      btc_dominance_pct: number;
      eth_btc_performance_pct: number;
      regime_state: string;
    };

    expect(row.btc_dominance_pct).toBe(55.5);
    expect(row.eth_btc_performance_pct).toBe(1.25);
    expect(row.regime_state).toBe('neutral');
  });

  it('stores null (not a coercion error) for a non-numeric btc_dominance_pct', () => {
    recordRegimeHistory(db, {
      run_id: 'run-1',
      generated_at: '2026-07-01T00:00:00+07:00',
      market_context: { btc_dominance_pct: 'not-a-number' },
      regime: {},
    });
    const row = db
      .prepare('SELECT btc_dominance_pct FROM market_regime_history WHERE run_id = ?')
      .get('run-1') as {
      btc_dominance_pct: number | null;
    };
    expect(row.btc_dominance_pct).toBeNull();
  });
});

describe('loadRegimeStates', () => {
  it('maps generated_at -> regime_state, excluding rows with a null regime_state', () => {
    recordRegimeHistory(db, {
      run_id: 'run-1',
      generated_at: '2026-07-01T00:00:00+07:00',
      regime: { regime_state: 'risk-on' },
    });
    recordRegimeHistory(db, {
      run_id: 'run-2',
      generated_at: '2026-07-02T00:00:00+07:00',
      regime: {},
    });

    const states = loadRegimeStates(db);
    expect(states).toEqual({ '2026-07-01T00:00:00+07:00': 'risk-on' });
    expect(states['2026-07-02T00:00:00+07:00']).toBeUndefined();
  });
});

describe('loadLatestRegimeState', () => {
  it('returns null when the table is empty', () => {
    expect(loadLatestRegimeState(db)).toBeNull();
  });

  it('returns the row with the greatest generated_at, regardless of insertion order', () => {
    recordRegimeHistory(db, {
      run_id: 'run-2',
      generated_at: '2026-07-02T00:00:00+07:00',
      market_context: { btc_dominance_pct: 56.0 },
      regime: { regime_state: 'risk-on' },
    });
    recordRegimeHistory(db, {
      run_id: 'run-1',
      generated_at: '2026-07-01T00:00:00+07:00',
      market_context: { btc_dominance_pct: 55.0 },
      regime: { regime_state: 'risk-off' },
    });

    const latest = loadLatestRegimeState(db);
    expect(latest).toEqual({
      btc_dominance_pct: 56.0,
      eth_btc_performance_pct: null,
      regime_state: 'risk-on',
    });
  });
});
