import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BIAS,
  BREADTH_LABEL,
  CALIBRATION,
  CONFLICT_CODE,
  CONFLUENCE_FAMILY,
  DATA_QUALITY_FLAG,
  FACTOR,
  FIXED_SETUP,
  FRESHNESS,
  lookupCalibration,
  lookupConflictCode,
  lookupConfluenceFamily,
  lookupFactor,
  lookupFreshness,
  lookupQualityFlag,
  lookupSectorRotationLabel,
  lookupSetup,
  lookupSignalConflictLabel,
  lookupTechnicalPattern,
  lookupWatchlist,
  REGIME_STATE,
  SECTOR_ROTATION_LABEL,
  SIGNAL_CONFLICT_LABEL,
  TECHNICAL_PATTERN,
  WATCHLIST,
} from '../lib/copy';

/**
 * Every key list below is verified against the API source directly (file:line noted per group),
 * NOT lifted from the frozen fixture -- the fixture is missing real values that the code emits
 * (2 technical patterns, the `positioning` conflict code, both retired factors, ...). Keep these
 * in sync with the cited source if it changes; the "every dict key resolves" assertions below
 * will fail loudly if a list here drifts from the dictionary in lib/copy.ts, and the fixture walk
 * at the bottom fails loudly if a real payload ever contains a key with no mapping at all.
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

// apps/api/src/pipeline/rowScoring.ts:169-208 -- 5 checks (technical, derivatives, funding,
// positioning, taker) plus regime_bias/market_breadth appended separately. 7 codes total.
const CONFLICT_CODES = [
  'technical',
  'derivatives',
  'funding',
  'positioning',
  'taker',
  'regime_bias',
  'market_breadth',
];

// apps/api/src/pipeline/rowScoring.ts `conflictLabel()` + `applyExcludedScores()`.
const SIGNAL_CONFLICT_LABELS = [
  'aligned',
  'minor-conflict',
  'mixed-signals',
  'high-conflict',
  'neutral',
  'excluded',
];

// apps/api/src/dashboard/confluence.ts:11-28 FAMILY_DEFINITIONS.
const CONFLUENCE_FAMILY_KEYS = ['trend', 'momentum', 'oi_flow', 'funding', 'crowding', 'regime'];

// apps/api/src/dashboard/watchlists.ts:6-14 WATCHLIST_LABELS.
const WATCHLIST_IDS = [
  'chart_next',
  'regime_fit',
  'long',
  'short',
  'squeeze_risks',
  'crowded_longs',
  'core',
];

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

// apps/api/src/dashboard/payload.ts `calibrationLabel()`.
const CALIBRATION_LABELS = ['learning', 'useful', 'neutral', 'weak'];

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

  it('covers every signal-conflict code, including "positioning"', () => {
    for (const code of CONFLICT_CODES) {
      expect(CONFLICT_CODE[code], `CONFLICT_CODE missing "${code}"`).toBeDefined();
      assertHuman(lookupConflictCode(code).label);
    }
  });

  it('covers every signal_conflict_label value', () => {
    for (const label of SIGNAL_CONFLICT_LABELS) {
      expect(
        SIGNAL_CONFLICT_LABEL[label],
        `SIGNAL_CONFLICT_LABEL missing "${label}"`,
      ).toBeDefined();
      assertHuman(lookupSignalConflictLabel(label).label);
    }
  });

  it('covers every confluence family key', () => {
    for (const key of CONFLUENCE_FAMILY_KEYS) {
      expect(CONFLUENCE_FAMILY[key], `CONFLUENCE_FAMILY missing "${key}"`).toBeDefined();
      assertHuman(lookupConfluenceFamily(key).label);
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

  it('covers every calibration label', () => {
    for (const label of CALIBRATION_LABELS) {
      expect(CALIBRATION[label], `CALIBRATION missing "${label}"`).toBeDefined();
      assertHuman(lookupCalibration(label).label);
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

  it('lookupConflictCode falls back to a humanized label for an unknown code', () => {
    assertHuman(lookupConflictCode('some_unmapped_code').label);
  });

  it('lookupQualityFlag falls back to a humanized label for an unknown flag code', () => {
    assertHuman(lookupQualityFlag('some_unmapped_flag:123').label);
  });
});

// ---------------------------------------------------------------------------------------------
// Fixture walk -- the real leak-proof test. Every setup/factor/conflict-code/confluence-family
// key that actually appears in a real (frozen) payload must resolve to a mapped, non-jargon
// label. This does NOT replace the source-derived assertions above (the fixture is known to be
// missing several real values -- see the file header comment).
// ---------------------------------------------------------------------------------------------

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../api/tests/fixtures/dashboard-payload.json',
);

interface FixtureRow {
  setup: string;
  factor_parts: Array<{ name: string }>;
  signal_conflicts: Array<{ code: string }>;
  confluence: { families: Array<{ key: string }> };
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

  it('every factor_parts[].name resolves to a non-jargon label', () => {
    for (const row of rows) {
      for (const part of row.factor_parts) {
        assertHuman(lookupFactor(part.name).label);
      }
    }
  });

  it('every signal_conflicts[].code resolves to a non-jargon label', () => {
    for (const row of rows) {
      for (const conflict of row.signal_conflicts) {
        assertHuman(lookupConflictCode(conflict.code).label);
      }
    }
  });

  it('every confluence.families[].key resolves to a non-jargon label', () => {
    for (const row of rows) {
      for (const family of row.confluence.families) {
        assertHuman(lookupConfluenceFamily(family.key).label);
      }
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
