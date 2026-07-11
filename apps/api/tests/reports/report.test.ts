import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import type { RunPayload } from '../../src/pipeline/models.js';
import { renderCsv } from '../../src/reports/csv.js';
import { renderJson } from '../../src/reports/json.js';
import { renderMarkdown } from '../../src/reports/markdown.js';
import { REPORT_FIELDS } from '../../src/reports/reportFields.js';
import { writeReports } from '../../src/reports/writeReports.js';

const EXPECTED_REPORT_FIELDS = [
  'symbol',
  'contract_symbol',
  'data_source',
  'price_usd',
  'price_change_24h_pct',
  'quote_volume_usd',
  'open_interest_usd',
  'oi_change_24h_pct',
  'funding_rate_pct',
  'long_short_ratio',
  'long_liquidation_usd_24h',
  'short_liquidation_usd_24h',
  'spread_bps',
  'depth_0_5pct_usd',
  'factor_score',
  'liquidity_quality',
  'confidence_score',
  'technical_setup',
  'technical_interval',
  'rsi_14',
  'macd_histogram_pct',
  'atr_14_pct',
  'bb_position',
  'bb_width_pct',
  'distance_ema20_pct',
  'technical_trend_score',
  'technical_momentum_score',
  'derivatives_interval',
  'oi_change_4h_pct_history',
  'oi_change_24h_pct_history',
  'oi_acceleration_4h_pct',
  'oi_zscore_30',
  'funding_avg_24h_pct',
  'funding_persistence_24h',
  'liquidation_imbalance_24h_pct',
  'taker_buy_sell_ratio_24h',
  'taker_imbalance_24h_pct',
  'derivatives_confirmation_score',
  'long_score',
  'short_score',
  'crowded_long_score',
  'squeeze_risk_score',
  'signal_conflict_label',
  'signal_conflict_score',
  'regime_alignment_score',
  'breadth_alignment_score',
  'is_trusted',
  'data_quality_score',
  'data_quality_flags',
];

describe('REPORT_FIELDS', () => {
  it('is the exact 49-column allowlist, in order', () => {
    expect(REPORT_FIELDS).toEqual(EXPECTED_REPORT_FIELDS);
  });
});

function buildPayload(): RunPayload {
  return {
    run_id: 'run-report-test',
    generated_at: '2026-07-11T14:23:05+07:00',
    rows: [
      {
        symbol: 'BTC',
        contract_symbol: 'BTCUSDT',
        data_source: 'coinglass',
        price_usd: 65000,
        price_change_24h_pct: 2.5,
        quote_volume_usd: 1_500_000_000,
        factor_score: 0.42,
        long_score: 10,
        confidence_score: 71.4,
        long_short_ratio: 1.12,
        technical_setup: 'Trend Continuation',
        is_trusted: true,
        data_quality_score: 100,
        // open_interest_usd intentionally omitted -- exercises missing-key -> empty-cell behavior.
        not_a_report_field: 'must be ignored by extrasaction=ignore equivalent',
      },
      {
        symbol: 'FLAGGED, "COIN"',
        data_source: 'coinglass',
        price_change_24h_pct: -12.34,
        factor_score: -0.1,
        is_trusted: false,
        data_quality_score: 40,
        data_quality_flags: ['stale_price', 'thin_liquidity'],
      },
    ],
    market_context: {
      total_market_cap_usd: 2_100_000_000_000,
      market_cap_change_24h_pct: 1.2,
      btc_dominance_pct: 54.3,
      eth_dominance_pct: 12.1,
    },
    provider_status: {
      coinglass: { status: 'ok', rows: 2 },
      coingecko: { status: 'error', reason: 'timeout' },
    },
    factor_weights: {
      history_records: 120,
      mode: 'ic',
      stats: {
        momentum_24h: { weight: 0.31, ic: 0.05, observations: 120, mode: 'ic' },
        reversal_3d: { weight: -0.08, ic: null, observations: 12, mode: 'prior' },
      },
      validation: { status: 'ok', observations: 120, horizon_hours: 24, model: { hit_rate: 55.5 } },
    },
    regime: {
      bias: 'risk-on',
      label: 'btc-led',
      bias_score: 0.42,
      avg_funding_rate_pct: 0.012,
      breadth_label: 'strong',
      breadth_score: 0.3,
      sector_rotation_label: 'alts-rotating',
    },
  };
}

// Minimal CSV splitter -- just enough to un-escape this fixture's quoted cell, not general-purpose.
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

describe('renderCsv', () => {
  const payload = buildPayload();

  it('writes the header as the exact REPORT_FIELDS list', () => {
    const csv = renderCsv(payload.rows);
    const headerLine = csv.split('\r\n')[0];
    expect(headerLine).toBe(REPORT_FIELDS.join(','));
  });

  it('drops row keys outside REPORT_FIELDS and renders missing fields as empty cells', () => {
    const csv = renderCsv(payload.rows);
    expect(csv).not.toContain('not_a_report_field');
    expect(csv).not.toContain('must be ignored');
    const btcRow = csv.split('\r\n')[1] as string;
    const cells = btcRow.split(',');
    expect(cells[REPORT_FIELDS.indexOf('open_interest_usd')]).toBe('');
  });

  it('quotes fields containing commas or quotes, doubling internal quotes', () => {
    const csv = renderCsv(payload.rows);
    expect(csv).toContain('"FLAGGED, ""COIN"""');
  });

  it('stringifies a list-valued field (data_quality_flags) as a Python-style list repr', () => {
    const csv = renderCsv(payload.rows);
    expect(csv).toContain("['stale_price', 'thin_liquidity']");
  });

  it('renders booleans as True/False, matching Python str(bool)', () => {
    const csv = renderCsv(payload.rows);
    const isTrustedIndex = REPORT_FIELDS.indexOf('is_trusted');
    const rows = csv.trim().split('\r\n').slice(1);
    expect(parseCsvLine(rows[0] as string)[isTrustedIndex]).toBe('True');
    expect(parseCsvLine(rows[1] as string)[isTrustedIndex]).toBe('False');
  });

  it('ends every line (including the last) with a CRLF terminator', () => {
    const csv = renderCsv(payload.rows);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n').filter((line) => line.length > 0)).toHaveLength(
      1 + payload.rows.length,
    );
  });
});

describe('renderJson', () => {
  it('sorts object keys lexicographically at every level and pretty-prints with 2-space indent', () => {
    const json = renderJson(buildPayload());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(json).toContain('\n  "factor_weights"');
    expect(parsed.run_id).toBe('run-report-test');
  });
});

describe('renderMarkdown', () => {
  const config = AppConfigSchema.parse({});

  it('renders every top-level section header', () => {
    const markdown = renderMarkdown(buildPayload(), config);
    for (const heading of [
      '# Crypto Quant Daily Report',
      '## Market Bias',
      '## Provider Status',
      '## Data Quality',
      '## Factor Regime',
      '## Dominance And Sector Rotation',
      '## BTC / ETH / SOL Core Read',
      '## Top Long Watchlist',
      '## Top Short Watchlist',
      '## Crowded Longs To Fade',
      '## Crowded Shorts / Squeeze Risk',
      '## Manual Chart Checklist',
    ]) {
      expect(markdown).toContain(heading);
    }
  });

  it('formats the market bias block from the regime/context dicts', () => {
    const markdown = renderMarkdown(buildPayload(), config);
    expect(markdown).toContain('- Bias: `risk-on`');
    expect(markdown).toContain('- Factor regime: `btc-led`');
    expect(markdown).toContain('- BTC dominance: `54.30%`');
  });

  it('falls back to "_No matches._" for a watchlist section with no candidates', () => {
    const emptyPayload: RunPayload = {
      ...buildPayload(),
      rows: [],
    };
    const markdown = renderMarkdown(emptyPayload, config);
    expect(markdown).toContain('_No matches._');
  });

  it('lists excluded rows in the data quality table with their flags', () => {
    const markdown = renderMarkdown(buildPayload(), config);
    expect(markdown).toContain('- Trusted rows used for ranking: `1`');
    expect(markdown).toContain('- Excluded rows: `1`');
    expect(markdown).toContain('stale_price, thin_liquidity');
  });
});

describe('writeReports', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crypto-screener-reports-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes json/csv/markdown files named crypto-quant-daily-{stamp} and returns their paths', () => {
    const config = AppConfigSchema.parse({});
    const payload = buildPayload();

    const paths = writeReports(payload, config, dir);

    expect(Object.keys(paths).sort()).toEqual(['csv', 'json', 'markdown']);
    expect(paths.json).toBe(join(dir, 'crypto-quant-daily-20260711-142305.json'));
    expect(paths.csv).toBe(join(dir, 'crypto-quant-daily-20260711-142305.csv'));
    expect(paths.markdown).toBe(join(dir, 'crypto-quant-daily-20260711-142305.md'));

    const jsonContent = readFileSync(paths.json as string, 'utf-8');
    expect(JSON.parse(jsonContent).run_id).toBe('run-report-test');

    const csvContent = readFileSync(paths.csv as string, 'utf-8');
    expect(csvContent.split('\r\n')[0]).toBe(REPORT_FIELDS.join(','));

    const mdContent = readFileSync(paths.markdown as string, 'utf-8');
    expect(mdContent).toContain('# Crypto Quant Daily Report');
  });
});
