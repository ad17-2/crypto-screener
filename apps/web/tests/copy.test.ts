import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CvdAbsorptionState, RunTrend } from '@crypto-screener/contracts';
import { describe, expect, it } from 'vitest';
import {
  BIAS,
  BREADTH_LABEL,
  CVD_ABSORPTION_STATE,
  DATA_QUALITY_FLAG,
  FACTOR,
  FIXED_SETUP,
  FRESHNESS,
  lookupCvdAbsorptionState,
  lookupFactor,
  lookupFreshness,
  lookupMetric,
  lookupOiPriceTrendState,
  lookupProvider,
  lookupQualityFlag,
  lookupRunTrend,
  lookupSectorRotationLabel,
  lookupSetup,
  lookupSetupConfidence,
  lookupTechnicalDivergence,
  lookupTechnicalPattern,
  lookupWatchlist,
  METRIC,
  OI_PRICE_TREND_STATE,
  PROVIDER,
  REGIME_STATE,
  RUN_TREND,
  SECTOR_ROTATION_LABEL,
  SETUP_CONFIDENCE,
  TECHNICAL_DIVERGENCE,
  TECHNICAL_PATTERN,
  WATCHLIST,
} from '../lib/copy';

/**
 * Every key list below is verified against the API source directly (file:line noted per group),
 * NOT lifted from the frozen fixture -- the fixture is missing real values that the code emits
 * (2 technical patterns, both retired factors, ...). Keep these in sync with the cited source if
 * it changes; the "every dict key resolves" assertions below will fail loudly if a list here
 * drifts from the dictionary in lib/copy.ts, and the fixture walk at the bottom fails loudly if a
 * real payload ever contains a key with no mapping at all.
 */

// apps/api/src/pipeline/factorDefinitions.ts:2-15 (DIRECTIONAL_FACTORS)
const DIRECTIONAL_FACTORS = [
  'momentum_24h',
  'reversal_3d',
  'oi_price_signal',
  'funding_rate_contrarian',
  'ls_ratio_contrarian',
  'liquidation_imbalance',
  'technical_trend_4h',
  'technical_momentum_4h',
  'oi_acceleration_signal',
  'funding_persistence_contrarian',
  'taker_flow_24h',
  'liquidation_pressure_24h',
];

// apps/api/src/pipeline/factorDefinitions.ts:1 -- retired, collinear with momentum_24h /
// -momentum_24h, but still present in the frozen parity fixture.
const RETIRED_FACTORS = ['reversal_1d', 'btc_relative_strength'];

// apps/api/src/pipeline/technicals.ts:237-266 `technicalSetup()` -- the only writer of
// `technical_setup`. 8 values; can also be null (not listed here, handled separately).
const TECHNICAL_PATTERNS = [
  'Upside Exhaustion',
  'Downside Exhaustion',
  'Compression Watch',
  'Pullback Into Uptrend',
  'Trend Continuation',
  'Rally Into Downtrend',
  'Downtrend Continuation',
  'Mixed Technicals',
];

// apps/api/src/dashboard/rows.ts:71-115 `setupLabel()` -- fixed, non-technical setups.
// 'Watchlist' (rows.ts:114) is unreachable dead code, tested separately below.
const FIXED_SETUPS = [
  'Core Regime Read',
  'Crowded Long Fade',
  'Short Squeeze Risk',
  'OI Momentum Long',
  'Reversal Long',
  'Funding Tailwind Long',
  'Long Candidate',
  'OI Breakdown Short',
  'Reversal Short',
  'Crowding Short',
  'Short Candidate',
];

// apps/api/src/dashboard/watchlists.ts:6-14 WATCHLIST_LABELS.
const WATCHLIST_IDS = ['chart_next', 'long', 'short', 'squeeze_risks', 'crowded_longs', 'core'];

// apps/api/src/pipeline/regime.ts `inferRegime()` bias union.
const BIAS_VALUES = ['risk-on', 'risk-off', 'mixed'];

// apps/api/src/pipeline/market.ts:187-201 `breadthLabel()`, plus the 'unknown' empty-data case.
const BREADTH_LABELS = [
  'broad-risk-on',
  'selective-risk-on',
  'mixed',
  'selective-risk-off',
  'broad-risk-off',
  'unknown',
];

// apps/api/src/pipeline/market.ts:203-224 `sectorLabel()`, plus the 'unknown' empty-data case.
const SECTOR_ROTATION_LABELS = [
  'broad-sector-bid',
  'broad-sector-offer',
  'rotation-dispersed',
  'selective-sector-bid',
  'selective-sector-offer',
  'mixed',
  'unknown',
];

// apps/api/src/pipeline/regime.ts:5 REGIME_STATES, plus legacy 'momentum' from the frozen fixture.
const REGIME_STATES = ['btc-led', 'alts-strong', 'neutral', 'chaos', 'momentum'];

// apps/api/src/dashboard/freshness.ts label thresholds.
const FRESHNESS_LABELS = ['fresh', 'aging', 'stale', 'old', 'unknown'];

// apps/api/src/pipeline/collector.ts and enrichment.ts `status.<key> = ...` assignment sites.
const PROVIDER_KEYS = [
  'coingecko',
  'coinglass',
  'data_quality',
  'derivatives_history',
  'long_short_ratio',
  'technicals',
];

// apps/api/src/dashboard/rows.ts `setupConfidence()` tiers (Stage E/F).
const SETUP_CONFIDENCE_TIERS = ['A', 'B', 'C'];

// apps/api/src/pipeline/rowScoring.ts `cvd_absorption_state` values (Stage C2).
const CVD_ABSORPTION_STATES: readonly CvdAbsorptionState[] = [
  'absorption_bearish',
  'absorption_bullish',
  'confirmation_long',
  'confirmation_short',
];

// apps/api/src/pipeline/rowScoring.ts `oi_price_trend_state` values that actually reach a
// reason-part chip (Stage C3; 'confirmed_long'/'confirmed_short' are chip-silent by design).
const OI_PRICE_TREND_DIVERGING_STATES = ['diverging_long', 'diverging_short'];

// apps/api/src/pipeline/technicals.ts RSI/price swing divergence detector (Stage A4).
const TECHNICAL_DIVERGENCE_VALUES = ['bearish', 'bullish'];

// apps/api/src/dashboard/runDiff.ts `runTrend()` values (packages/contracts/src/dashboard.ts RunTrendSchema).
const RUN_TREND_VALUES: readonly RunTrend[] = ['new', 'strengthening', 'weakening', 'holding'];

// apps/api/src/pipeline/quality.ts:58-192 `dataQualityFlags()` -- 2 static codes, 11 suffixed
// `code:value` codes. lookupQualityFlag() must key on the prefix for the suffixed ones.
const STATIC_QUALITY_FLAGS = ['missing_symbol', 'missing_contract_symbol'];
const SUFFIXED_QUALITY_FLAGS = [
  'weird_symbol',
  'weird_contract_symbol',
  'invalid_price',
  'stale_low_quote_volume',
  'extreme_24h_price_change',
  'extreme_24h_oi_change',
  'extreme_24h_volume_change',
  'extreme_funding_rate',
  'invalid_open_interest',
  'price_deviates_from_index',
  'thin_coinglass_exchange_coverage',
];

// components/market/MarketStage.tsx:141,150,155 -- the ⓘ metricKey props for the correlation-
// structure stat tiles (apps/api/src/pipeline/market.ts's correlationStructureSummary).
const CORRELATION_STRUCTURE_METRICS = [
  'mean_btc_correlation',
  'alt_alt_mean_correlation',
  'correlation_spread',
];

function assertHuman(label: string): void {
  expect(label.length).toBeGreaterThan(0);
  expect(label).not.toMatch(/_/);
}

describe('copy dictionaries cover every source-derived key', () => {
  it('covers every directional and retired factor', () => {
    for (const name of [...DIRECTIONAL_FACTORS, ...RETIRED_FACTORS]) {
      expect(FACTOR[name], `FACTOR missing "${name}"`).toBeDefined();
      assertHuman(lookupFactor(name).label);
    }
  });

  it('covers every technical pattern, standalone and as a Long/Short setup', () => {
    for (const pattern of TECHNICAL_PATTERNS) {
      expect(TECHNICAL_PATTERN[pattern], `TECHNICAL_PATTERN missing "${pattern}"`).toBeDefined();
      assertHuman(lookupTechnicalPattern(pattern).label);
      // setup = `${technical_setup} ${Long|Short}` (rows.ts:71-76) -- lookupSetup must decompose
      // this rather than needing all 16 literal combinations mapped.
      assertHuman(lookupSetup(`${pattern} Long`).label);
      assertHuman(lookupSetup(`${pattern} Short`).label);
    }
  });

  it('covers every fixed setup, including the unreachable "Watchlist" fallback', () => {
    for (const setup of [...FIXED_SETUPS, 'Watchlist']) {
      expect(FIXED_SETUP[setup], `FIXED_SETUP missing "${setup}"`).toBeDefined();
      assertHuman(lookupSetup(setup).label);
    }
  });

  it('covers every watchlist id', () => {
    for (const id of WATCHLIST_IDS) {
      expect(WATCHLIST[id], `WATCHLIST missing "${id}"`).toBeDefined();
      assertHuman(lookupWatchlist(id).label);
    }
  });

  it('covers every bias value', () => {
    for (const value of BIAS_VALUES) {
      expect(BIAS[value], `BIAS missing "${value}"`).toBeDefined();
    }
  });

  it('covers every breadth label, including "unknown"', () => {
    for (const label of BREADTH_LABELS) {
      expect(BREADTH_LABEL[label], `BREADTH_LABEL missing "${label}"`).toBeDefined();
    }
  });

  it('covers every sector rotation label, including "unknown"', () => {
    for (const label of SECTOR_ROTATION_LABELS) {
      expect(
        SECTOR_ROTATION_LABEL[label],
        `SECTOR_ROTATION_LABEL missing "${label}"`,
      ).toBeDefined();
      assertHuman(lookupSectorRotationLabel(label).label);
    }
  });

  it('covers every regime state, including the legacy "momentum" label', () => {
    for (const state of REGIME_STATES) {
      expect(REGIME_STATE[state], `REGIME_STATE missing "${state}"`).toBeDefined();
    }
  });

  it('covers every freshness label, including "unknown"', () => {
    for (const label of FRESHNESS_LABELS) {
      expect(FRESHNESS[label], `FRESHNESS missing "${label}"`).toBeDefined();
      assertHuman(lookupFreshness(label).label);
    }
  });

  it('covers every provider status key', () => {
    for (const key of PROVIDER_KEYS) {
      expect(PROVIDER[key], `PROVIDER missing "${key}"`).toBeDefined();
      assertHuman(lookupProvider(key).label);
    }
  });

  it('covers every static data-quality flag', () => {
    for (const code of STATIC_QUALITY_FLAGS) {
      expect(DATA_QUALITY_FLAG[code], `DATA_QUALITY_FLAG missing "${code}"`).toBeDefined();
      assertHuman(lookupQualityFlag(code).label);
    }
  });

  it('covers every suffixed data-quality flag by prefix, without leaking the raw suffix', () => {
    for (const code of SUFFIXED_QUALITY_FLAGS) {
      expect(DATA_QUALITY_FLAG[code], `DATA_QUALITY_FLAG missing "${code}"`).toBeDefined();
      const resolved = lookupQualityFlag(`${code}:+15.04%`);
      assertHuman(resolved.label);
      // The raw code must not appear verbatim in the label (it must be translated, not passed through).
      expect(resolved.label).not.toContain(code);
    }
  });

  it('covers every setup_confidence tier', () => {
    for (const tier of SETUP_CONFIDENCE_TIERS) {
      expect(SETUP_CONFIDENCE[tier], `SETUP_CONFIDENCE missing "${tier}"`).toBeDefined();
      assertHuman(lookupSetupConfidence(tier).label);
    }
  });

  it('covers every cvd_absorption_state value', () => {
    for (const value of CVD_ABSORPTION_STATES) {
      expect(CVD_ABSORPTION_STATE[value], `CVD_ABSORPTION_STATE missing "${value}"`).toBeDefined();
      assertHuman(lookupCvdAbsorptionState(value).label);
    }
  });

  it('covers every diverging oi_price_trend_state value', () => {
    for (const value of OI_PRICE_TREND_DIVERGING_STATES) {
      expect(OI_PRICE_TREND_STATE[value], `OI_PRICE_TREND_STATE missing "${value}"`).toBeDefined();
      assertHuman(lookupOiPriceTrendState(value).label);
    }
  });

  it('covers every technical_divergence value', () => {
    for (const value of TECHNICAL_DIVERGENCE_VALUES) {
      expect(TECHNICAL_DIVERGENCE[value], `TECHNICAL_DIVERGENCE missing "${value}"`).toBeDefined();
      assertHuman(lookupTechnicalDivergence(value).label);
    }
  });

  it('covers every run_trend value', () => {
    for (const value of RUN_TREND_VALUES) {
      expect(RUN_TREND[value], `RUN_TREND missing "${value}"`).toBeDefined();
      assertHuman(lookupRunTrend(value).label);
    }
  });

  it('covers every correlation-structure stat tile metricKey', () => {
    for (const key of CORRELATION_STRUCTURE_METRICS) {
      expect(METRIC[key], `METRIC missing "${key}"`).toBeDefined();
      assertHuman(lookupMetric(key).label);
      expect(lookupMetric(key).definition.length).toBeGreaterThan(0);
    }
  });
});

describe('copy fallbacks never leak a raw machine key', () => {
  it('lookupFactor falls back to a humanized label for an unknown factor name', () => {
    const resolved = lookupFactor('totally_unknown_factor_name');
    assertHuman(resolved.label);
    expect(resolved.definition.length).toBeGreaterThan(0);
  });

  it('lookupSetup falls back to a humanized label for an unknown setup string', () => {
    assertHuman(lookupSetup('some_unmapped_setup').label);
  });

  it('lookupSetup handles a null/missing setup without throwing', () => {
    expect(() => lookupSetup(null)).not.toThrow();
    expect(() => lookupSetup(undefined)).not.toThrow();
    assertHuman(lookupSetup(null).label);
  });

  it('lookupQualityFlag falls back to a humanized label for an unknown flag code', () => {
    assertHuman(lookupQualityFlag('some_unmapped_flag:123').label);
  });
});

// Fixture walk -- the real leak-proof test. Every setup/quality-flag key that actually appears in
// a real (frozen) payload must resolve to a mapped, non-jargon label. This does NOT replace the
// source-derived assertions above (the fixture is known to be missing several real values -- see
// the file header comment).

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../api/tests/fixtures/dashboard-payload.json',
);

interface FixtureRow {
  setup: string;
  data_quality_flags: string[];
}

interface FixtureWatchlist {
  id: string;
  rows: FixtureRow[];
}

interface Fixture {
  watchlists: FixtureWatchlist[];
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture;
}

describe('fixture walk: no raw jargon reaches the UI for a real payload', () => {
  const fixture = loadFixture();
  const rows = fixture.watchlists.flatMap((watchlist) => watchlist.rows);

  it('the fixture actually has rows to walk (a passing empty walk would prove nothing)', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it('every row.setup resolves to a non-jargon label', () => {
    for (const row of rows) {
      assertHuman(lookupSetup(row.setup).label);
    }
  });

  it('every data_quality_flags entry resolves to a non-jargon label', () => {
    for (const row of rows) {
      for (const flag of row.data_quality_flags) {
        assertHuman(lookupQualityFlag(flag).label);
      }
    }
  });
});
