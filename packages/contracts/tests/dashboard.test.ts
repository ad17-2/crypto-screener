import { describe, expect, it } from 'vitest';
import { DashboardPayloadSchema, DashboardRowSchema } from '../src/dashboard';

const sampleRow = {
  symbol: 'BTC',
  side: 'long',
  setup: 'OI Momentum Long',
  setup_tone: 'pos',
  score_field: 'long_score',
  score: 42.5,
  priority: 38.1,
  confidence_score: 61,
  quality: 100,
  primary_exchange: 'Binance',
  contract_symbol: 'BTCUSDT',
  price_usd: 65000.12,
  price_change_24h_pct: 2.4,
  oi_change_24h_pct: 1.1,
  funding_rate_pct: 0.01,
  long_short_ratio: 1.05,
  long_short_account_ratio: 1.02,
  top_trader_long_short_ratio: 1.1,
  positioning_ratio: 1.02,
  funding_percentile: 55,
  oi_change_percentile: 60,
  positioning_percentile: 50,
  confluence: {
    direction: 'long',
    aligned: 3,
    against: 1,
    neutral: 1,
    total: 5,
    net_score: 2,
    families: [{ key: 'technical', label: 'Technical', tone: 'pos', value: 0.4 }],
  },
  confluence_score: 2,
  quote_volume_usd: 500_000_000,
  open_interest_usd: 1_000_000_000,
  technical_setup: 'Bullish Trend',
  technical_state: { rsi_14: 58.2, ema_20: 64000.1 },
  signal_conflict_label: 'aligned',
  signal_conflict_score: 0,
  signal_conflicts: [],
  regime_alignment_score: 0.3,
  breadth_alignment_score: 0.2,
  data_source: 'coinglass',
  is_trusted: true,
  data_quality_flags: [],
  scores: {
    factor_score: 0.42,
    long_score: 42.5,
    short_score: 0,
    crowded_long_score: 10,
    squeeze_risk_score: 5,
    confidence_score: 61,
    signal_conflict_score: 0,
    regime_alignment_score: 0.3,
    breadth_alignment_score: 0.2,
    round_trip_cost_pct: 0.16,
  },
  factor_parts: [{ name: 'momentum_24h', label: 'Momentum', value: 0.42, tone: 'pos' }],
  primary_driver: { name: 'momentum_24h', label: 'Momentum', value: 0.42, tone: 'pos' },
  history: [
    {
      generated_at: '2026-07-10T12:00:00+00:00',
      price_usd: 64000,
      price_change_24h_pct: 1.8,
      oi_change_24h_pct: 0.9,
      funding_rate_pct: 0.008,
      long_short_ratio: 1.03,
      long_short_account_ratio: 1.01,
      top_trader_long_short_ratio: 1.05,
      quote_volume_usd: 480_000_000,
      confidence_score: 58,
      technical_trend_4h: 0.5,
      technical_momentum_4h: 0.3,
      rsi_14: 56.1,
      factor_score: 0.38,
      long_score: 40.1,
      short_score: 0,
      crowded_long_score: 8,
      squeeze_risk_score: 4,
      signal_conflict_score: 0,
    },
  ],
  reason: 'BTC is grouped as OI Momentum Long because Momentum +0.42 is the strongest driver.',
  reason_parts: [
    {
      kind: 'metric',
      label: '24h',
      value: '+2.40%',
      tone: 'pos',
      help: 'Spot or mark price change over the last 24 hours.',
    },
  ],
  explanation: {
    read: 'BTC is grouped as OI Momentum Long.',
    confirm: ['Check the chart.'],
    risk: ['Main risk is chart invalidation after manual review.'],
  },
};

describe('DashboardRowSchema', () => {
  it('parses a well-formed row', () => {
    expect(() => DashboardRowSchema.parse(sampleRow)).not.toThrow();
  });

  it('rejects a row missing a required field', () => {
    const { setup: _setup, ...withoutSetup } = sampleRow;
    expect(() => DashboardRowSchema.parse(withoutSetup)).toThrow();
  });

  it('rejects an unknown side value', () => {
    expect(() => DashboardRowSchema.parse({ ...sampleRow, side: 'sideways' })).toThrow();
  });
});

describe('DashboardPayloadSchema', () => {
  it('parses the empty-database payload shape', () => {
    const payload = {
      status: 'empty',
      database: 'data/crypto_screener.sqlite3',
      runs: [],
      refresh_status: null,
    };
    expect(() => DashboardPayloadSchema.parse(payload)).not.toThrow();
  });

  it('parses a full ok payload', () => {
    const payload = {
      status: 'ok',
      database: 'data/crypto_screener.sqlite3',
      run: { run_id: 'run_1', generated_at: '2026-07-11T00:00:00+00:00', row_count: 1 },
      runs: [
        {
          run_id: 'run_1',
          generated_at: '2026-07-11T00:00:00+00:00',
          row_count: 1,
          excluded_count: 0,
          bias: 'risk-on',
          factor_regime: 'trend',
          coinglass_status: 'ok',
        },
      ],
      regime: { bias: 'risk-on', label: 'trend' },
      market_context: { breadth_score: 0.4 },
      provider_status: { coinglass: { status: 'ok' } },
      factor_weights: { mode: 'ic', stats: {} },
      model_weights: {
        mode: 'ic',
        regime: { label: 'trend' },
        factors: [
          {
            name: 'momentum_24h',
            label: 'Momentum',
            weight: 0.3,
            base_weight: 0.3,
            mode: 'ic',
            ic: 0.05,
            t_stat: 2.1,
            n_periods: 40,
            credibility_k: 0.8,
            regime_multiplier: 1.1,
            robustness: 'robust',
            oos_ic: 0.04,
            regime_ic: 0.06,
            regime_mode: 'trend',
          },
        ],
        factor_correlations: [
          { a: 'momentum_24h', b: 'reversal_3d', rho: -0.82, verdict: 'redundant' },
        ],
        factor_decay: {},
        walk_forward: {},
      },
      factor_correlations: [
        { a: 'momentum_24h', b: 'reversal_3d', rho: -0.82, verdict: 'redundant' },
      ],
      factor_decay: {},
      walk_forward: {},
      validation: { observations: 100 },
      freshness: {
        status: 'ok',
        label: 'fresh',
        generated_at: '2026-07-11T00:00:00+00:00',
        age_seconds: 60,
        age_minutes: 1,
      },
      quality: { trusted_count: 1, excluded_count: 0, flagged_count: 0, flagged_rows: [] },
      sections: {
        core: [sampleRow],
        long: [sampleRow],
        regime_fit: [],
        short: [],
        crowded_longs: [],
        squeeze_risks: [],
      },
      watchlists: [
        { id: 'chart_next', label: 'Top Setups', rows: [sampleRow] },
        { id: 'core', label: 'Core', rows: [sampleRow] },
      ],
    };

    expect(() => DashboardPayloadSchema.parse(payload)).not.toThrow();
  });

  it('rejects an unrecognized status', () => {
    expect(() => DashboardPayloadSchema.parse({ status: 'weird' })).toThrow();
  });
});
