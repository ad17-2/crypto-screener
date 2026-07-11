/**
 * The dashboard's translation layer. The API returns machine-readable keys (setup strings,
 * factor names, conflict codes, regime/breadth labels, ...) alongside its own prose. The UI must
 * never render those raw keys -- every one of them is looked up here and turned into plain
 * English, with the technical term (if any) pushed into `definition` for a tooltip instead of the
 * page itself.
 *
 * Key sets are derived from the API source, not guessed -- see the comment above each dictionary
 * for where it was verified. When the API adds a new value, add it here; the exhaustiveness test
 * in tests/copy.test.ts fails loudly if a real payload contains a key with no mapping.
 */

export interface CopyEntry {
  readonly label: string;
  readonly definition: string;
}

function humanize(raw: string): string {
  const spaced = raw.replace(/[_-]+/g, ' ').trim();
  if (!spaced) return 'Unknown';
  return spaced
    .split(' ')
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function unknownEntry(raw: string): CopyEntry {
  return { label: humanize(raw), definition: `Unrecognized value from the API: "${raw}".` };
}

function makeLookup(dict: Record<string, CopyEntry>, missing: CopyEntry) {
  return (key: string | null | undefined): CopyEntry => {
    if (!key) return missing;
    return dict[key] ?? unknownEntry(key);
  };
}

const NOT_REPORTED: CopyEntry = { label: 'Not reported', definition: 'Not present on this row.' };

// ---------------------------------------------------------------------------------------------
// 1. SETUP -- apps/api/src/dashboard/rows.ts `setupLabel()`, built from either a fixed side-based
// string, or `${technical_setup} ${Long|Short}` where technical_setup comes from
// apps/api/src/pipeline/technicals.ts `technicalSetup()` (8 patterns; can also be null when there
// aren't enough candles). Direction (Long/Short) is stripped and handled by the caller (side/tone
// styling elsewhere), not baked into these labels.
// ---------------------------------------------------------------------------------------------

/** technicals.ts:237-266 -- the ONLY writer of `technical_setup`. */
export const TECHNICAL_PATTERN: Record<string, CopyEntry> = {
  'Compression Watch': {
    label: 'Coiling — may break out',
    definition:
      'Bollinger Band width on the 4h chart is unusually tight (a technical compression/squeeze) — price often makes a bigger move once it resolves.',
  },
  'Downside Exhaustion': {
    label: 'Selling looks exhausted',
    definition:
      '4h RSI is deeply oversold and price is pinned to the lower Bollinger Band — selling pressure may be running out.',
  },
  'Downtrend Continuation': {
    label: 'Downtrend continuing',
    definition:
      'The 4h trend score is strongly negative and price is holding at/below the 20-period EMA — a downtrend continuing without a bounce.',
  },
  'Mixed Technicals': {
    label: 'Chart is mixed',
    definition:
      'Neither the trend score nor the exhaustion/compression checks are strongly one-sided on the 4h chart right now.',
  },
  'Pullback Into Uptrend': {
    label: 'Uptrend, pulling back',
    definition:
      'The 4h trend score is strongly positive, but price has dipped below the 20-period EMA — a pullback within an intact uptrend.',
  },
  'Rally Into Downtrend': {
    label: 'Downtrend, rallying',
    definition:
      'The 4h trend score is strongly negative, but price has rallied above the 20-period EMA — a bounce within an intact downtrend.',
  },
  'Trend Continuation': {
    label: 'Trend continuing',
    definition:
      'The 4h trend score is strongly positive and price is holding at/above the 20-period EMA — an uptrend continuing without a pullback.',
  },
  'Upside Exhaustion': {
    label: 'Buying looks exhausted',
    definition:
      '4h RSI is deeply overbought and price is pinned to the upper Bollinger Band — buying pressure may be running out.',
  },
};

/** rows.ts:71-115 -- the non-technical, side-driven setups (plus core/watchlist fallbacks). */
export const FIXED_SETUP: Record<string, CopyEntry> = {
  'Core Regime Read': {
    label: 'Market bellwether',
    definition:
      'One of the three bellwether coins (BTC, ETH, SOL), always shown for context regardless of setup.',
  },
  'Crowded Long Fade': {
    label: 'Crowded long — fade candidate',
    definition:
      'Funding and/or the long/short ratio show long positioning is crowded, with rising open interest and price — a candidate to fade, not to chase.',
  },
  'Short Squeeze Risk': {
    label: 'Crowded short — squeeze risk',
    definition:
      'Funding and/or the long/short ratio show short positioning is crowded, with rising open interest and price — a squeeze could force shorts to cover.',
  },
  'OI Momentum Long': {
    label: 'New money pushing up',
    definition:
      'Price and open interest are both rising together — new long positioning is confirming the move, not just existing positions changing hands.',
  },
  'Reversal Long': {
    label: 'Bouncing after a drop',
    definition:
      "Price fell while open interest didn't expand — looks more like a bounce than a fresh trend.",
  },
  'Funding Tailwind Long': {
    label: 'Shorts are paying longs',
    definition:
      'Funding is negative, meaning shorts pay longs to hold their position — a structural tailwind for staying long.',
  },
  'Long Candidate': {
    label: 'Long candidate',
    definition: "A bullish setup that didn't fit a more specific pattern above.",
  },
  'OI Breakdown Short': {
    label: 'New shorts pressing down',
    definition:
      'Price is falling while open interest is rising — new short positioning is confirming the move down.',
  },
  'Reversal Short': {
    label: 'Fading a pop',
    definition:
      "Price rose while open interest didn't expand — looks more like a fade than a fresh downtrend.",
  },
  'Crowding Short': {
    label: 'Crowded long — may unwind',
    definition:
      'Funding is positive and/or the long/short ratio is elevated — long positioning looks crowded and could unwind, supporting the short case.',
  },
  'Short Candidate': {
    label: 'Short candidate',
    definition: "A bearish setup that didn't fit a more specific pattern above.",
  },
  // Unreachable in current code (rows.ts:114 is a dead-code fallback), mapped anyway as cheap insurance.
  Watchlist: {
    label: 'Watchlist',
    definition: 'A generic watchlist entry with no specific long/short/core classification.',
  },
};

const NO_SETUP: CopyEntry = {
  label: 'No setup',
  definition: 'This row has no assigned setup.',
};

const NO_TECHNICAL_READ: CopyEntry = {
  label: 'No 4h read',
  definition:
    "The 4h technical read isn't available for this coin right now (not enough candle history, or the technicals provider is disabled).",
};

/** Resolves a row's full `setup` string (e.g. "Compression Watch Long", "Reversal Short"). */
export function lookupSetup(setup: string | null | undefined): CopyEntry {
  if (!setup) return NO_SETUP;
  const fixed = FIXED_SETUP[setup];
  if (fixed) return fixed;
  for (const suffix of [' Long', ' Short'] as const) {
    if (setup.endsWith(suffix)) {
      const pattern = TECHNICAL_PATTERN[setup.slice(0, -suffix.length)];
      if (pattern) return pattern;
    }
  }
  return unknownEntry(setup);
}

/** Resolves the standalone `technical_setup` field (no direction suffix). May be null. */
export function lookupTechnicalPattern(pattern: string | null | undefined): CopyEntry {
  if (!pattern) return NO_TECHNICAL_READ;
  return TECHNICAL_PATTERN[pattern] ?? unknownEntry(pattern);
}

// ---------------------------------------------------------------------------------------------
// 2. FACTOR -- apps/api/src/pipeline/factorDefinitions.ts `DIRECTIONAL_FACTORS` (12 live factors)
// plus the 2 RETIRED factors (reversal_1d, btc_relative_strength) that still appear in the frozen
// fixture. QUALITY_FACTORS (liquidity_30d, volume_expansion_24h, volatility_expansion_4h) are
// intentionally excluded: they never reach the payload with a label (they're liquidity/quality
// inputs, not directional drivers shown to the user).
// ---------------------------------------------------------------------------------------------

export const FACTOR: Record<string, CopyEntry> = {
  momentum_24h: {
    label: '24h momentum',
    definition:
      "The coin's raw 24-hour price change — the plain momentum signal; positive means it already rallied, negative means it already dropped.",
  },
  reversal_3d: {
    label: '3-day reversal',
    definition:
      'The negative of the 3-day (72h) price change, scaled by volatility (ATR) — a mean-reversion bet against an extended 3-day move.',
  },
  oi_price_signal: {
    label: 'Open interest vs price',
    definition:
      'Whether open interest is rising in the same direction price is moving — rising OI alongside the move suggests new money, not just existing positions changing hands.',
  },
  funding_rate_contrarian: {
    label: 'Funding, contrarian',
    definition:
      'The negative of the funding rate — leans against crowded funding, e.g. very positive funding (longs paying shorts) counts against more upside.',
  },
  ls_ratio_contrarian: {
    label: 'Long/short ratio, contrarian',
    definition:
      'Leans against a crowded long/short account ratio rather than following it (a very high ratio counts against more upside, and vice versa).',
  },
  liquidation_imbalance: {
    label: 'Liquidation imbalance',
    definition:
      'Net imbalance between long and short liquidations over 24h; more shorts liquidated than longs (a short squeeze) reads bullish, and vice versa.',
  },
  technical_trend_4h: {
    label: '4h trend',
    definition:
      'A 4h chart trend read (EMA/price structure) — confirms whether the intraday trend agrees with the setup direction.',
  },
  technical_momentum_4h: {
    label: '4h momentum',
    definition:
      'A 4h chart momentum read (RSI/MACD-style) — confirms whether short-term momentum agrees with the setup direction.',
  },
  oi_acceleration_signal: {
    label: 'Open interest acceleration',
    definition:
      'Whether the pace of open-interest growth (not just its level) is speeding up in the direction price is moving — flags fresh, accelerating positioning.',
  },
  funding_persistence_contrarian: {
    label: 'Sustained funding, contrarian',
    definition:
      'The negative of the 24h average funding rate — like the funding factor, but based on funding sustained over the full day rather than the latest print.',
  },
  taker_flow_24h: {
    label: 'Taker flow',
    definition:
      'The imbalance between aggressive (market) buy and sell orders over 24h — positive means buyers have been more aggressive, negative means sellers have.',
  },
  liquidation_pressure_24h: {
    label: 'Liquidation pressure',
    definition:
      'A 24h read on liquidation imbalance and pressure — large one-sided liquidations can accelerate a move in that direction.',
  },
  // Retired -- collinear with momentum_24h, removed from the model. Kept mapped because the
  // frozen parity fixture still carries historical rows with these names.
  reversal_1d: {
    label: '1-day reversal (retired)',
    definition:
      'Retired factor: the negative of the 24h price change scaled by volatility. It was mathematically the exact opposite of the momentum factor (correlation −1.0), so it added no independent information and was removed from the model.',
  },
  btc_relative_strength: {
    label: 'Relative strength vs BTC (retired)',
    definition:
      'Retired factor: how much the coin outperformed or underperformed Bitcoin over 24h. It moved in lockstep with the momentum factor (correlation +1.0), so it added no independent information and was removed from the model.',
  },
};

export const lookupFactor = makeLookup(FACTOR, NOT_REPORTED);

// ---------------------------------------------------------------------------------------------
// 3. CONFLUENCE_FAMILY -- apps/api/src/dashboard/confluence.ts `FAMILY_DEFINITIONS` (6 families).
// ---------------------------------------------------------------------------------------------

export const CONFLUENCE_FAMILY: Record<string, CopyEntry> = {
  trend: {
    label: 'Trend',
    definition: 'Whether the 4h trend factor confirms this setup direction.',
  },
  momentum: {
    label: 'Momentum',
    definition:
      'Whether the momentum-family factors (24h momentum, 4h momentum, 3-day reversal) confirm this setup direction.',
  },
  oi_flow: {
    label: 'Positioning flow',
    definition:
      'Whether open interest, taker flow, and liquidations confirm this setup direction — is new money flowing the same way as price?',
  },
  funding: {
    label: 'Funding',
    definition:
      'Whether the funding-rate factors confirm this setup direction (contrarian to crowded funding).',
  },
  crowding: {
    label: 'Crowding',
    definition:
      'Whether the long/short ratio factor confirms this setup direction (contrarian to a crowded long/short ratio).',
  },
  regime: {
    label: 'Regime & breadth',
    definition:
      'Whether the overall market regime and breadth (how many coins are moving the same way) support this setup direction.',
  },
};

export const lookupConfluenceFamily = makeLookup(CONFLUENCE_FAMILY, {
  label: 'Unknown family',
  definition: 'Not reported for this row.',
});

// ---------------------------------------------------------------------------------------------
// 4. CONFLICT_CODE -- apps/api/src/pipeline/rowScoring.ts `signalConflictSummary()` checks array
// (technical, derivatives, funding, positioning, taker) plus regime_bias/market_breadth appended
// separately. 7 codes total -- `positioning` is easy to miss since it isn't in the checks' names.
// ---------------------------------------------------------------------------------------------

export const CONFLICT_CODE: Record<string, CopyEntry> = {
  technical: {
    label: '4h chart disagrees',
    definition:
      'The 4h trend/momentum technical read points the other way from this setup direction.',
  },
  derivatives: {
    label: 'Derivatives disagree',
    definition:
      'The combined derivatives confirmation score (OI, funding, taker flow together) points the other way from this setup direction.',
  },
  funding: {
    label: 'Funding disagrees',
    definition:
      'The funding-rate signal is pointing against this setup direction (the contrarian funding read disagrees).',
  },
  positioning: {
    label: 'OI/price disagrees',
    definition: "Open interest isn't confirming the price move in this setup direction.",
  },
  taker: {
    label: 'Taker flow disagrees',
    definition:
      'Aggressive buy/sell order flow over the last 24h is leaning the other way from this setup direction.',
  },
  regime_bias: {
    label: 'Market regime disagrees',
    definition:
      'The overall market regime (risk-on/risk-off) is leaning against this setup direction.',
  },
  market_breadth: {
    label: 'Market breadth disagrees',
    definition: 'Most coins in the market are moving the other way from this setup direction.',
  },
};

export const lookupConflictCode = makeLookup(CONFLICT_CODE, {
  label: 'Unknown conflict',
  definition: 'Not reported for this row.',
});

// ---------------------------------------------------------------------------------------------
// 5. SIGNAL_CONFLICT_LABEL -- rowScoring.ts `conflictLabel()` (aligned/minor-conflict/
// mixed-signals/high-conflict/neutral) plus `excluded` from `applyExcludedScores()`.
// ---------------------------------------------------------------------------------------------

export const SIGNAL_CONFLICT_LABEL: Record<string, CopyEntry> = {
  aligned: {
    label: 'Signals agree',
    definition:
      'None of the tracked signals (technicals, derivatives, funding, taker flow, OI/price, regime, breadth) disagree with this setup direction.',
  },
  'minor-conflict': {
    label: 'Mostly agree',
    definition:
      'Exactly one signal disagrees, and only mildly — most of the picture still lines up.',
  },
  'mixed-signals': {
    label: 'Mixed signals',
    definition:
      'More than one signal disagrees with this setup direction, or the disagreement is moderate — a genuinely mixed picture.',
  },
  'high-conflict': {
    label: 'Signals disagree',
    definition:
      'Multiple signals disagree, or at least one disagrees strongly — treat this setup with real caution.',
  },
  neutral: {
    label: 'No clear direction',
    definition:
      "The model's directional score is too close to zero to call a side, so no conflict check was run.",
  },
  excluded: {
    label: 'Excluded from ranking',
    definition: 'This row failed a data-quality check and was excluded from scoring and ranking.',
  },
};

export const lookupSignalConflictLabel = makeLookup(SIGNAL_CONFLICT_LABEL, {
  label: 'Unknown',
  definition: 'Not reported for this row.',
});

// ---------------------------------------------------------------------------------------------
// 6. WATCHLIST -- apps/api/src/dashboard/watchlists.ts `WATCHLIST_LABELS` keys (7 ids).
// ---------------------------------------------------------------------------------------------

export const WATCHLIST: Record<string, CopyEntry> = {
  chart_next: {
    label: 'Best setups',
    definition:
      'The single best setups across every list, ranked by priority — the top picks for right now.',
  },
  regime_fit: {
    label: "Fits today's regime",
    definition:
      "Setups chosen to match today's specific market regime and bias (e.g. favoring shorts in a risk-off regime).",
  },
  long: {
    label: 'Longs',
    definition: 'Coins with the strongest bullish (long) factor score.',
  },
  short: {
    label: 'Shorts',
    definition: 'Coins with the strongest bearish (short) factor score.',
  },
  crowded_longs: {
    label: 'Crowded longs',
    definition:
      'Coins where long positioning looks crowded (high funding and/or long/short ratio) — candidates for a long fade, not a fresh long.',
  },
  squeeze_risks: {
    label: 'Squeeze risk',
    definition:
      'Coins where short positioning looks crowded — candidates for a short-squeeze bounce, not a fresh short.',
  },
  core: {
    label: 'Majors',
    definition: 'The three bellwether coins (BTC, ETH, SOL), shown regardless of setup.',
  },
};

export const lookupWatchlist = makeLookup(WATCHLIST, {
  label: 'Unknown list',
  definition: 'Not reported.',
});

// ---------------------------------------------------------------------------------------------
// 7. BIAS / BREADTH_LABEL / SECTOR_ROTATION_LABEL / REGIME_STATE / FRESHNESS / CALIBRATION
// ---------------------------------------------------------------------------------------------

/** apps/api/src/pipeline/regime.ts `inferRegime()` -- bias is 'risk-on' | 'risk-off' | 'mixed'. */
export const BIAS: Record<string, CopyEntry> = {
  'risk-on': {
    label: 'Risk-on',
    definition:
      "Conditions favor risk-taking: BTC and market cap are up, breadth is positive, and funding isn't overly stretched.",
  },
  'risk-off': {
    label: 'Risk-off',
    definition:
      'Conditions favor caution: BTC and/or market cap are down, breadth is negative, and/or funding is stretched.',
  },
  mixed: {
    label: 'Mixed',
    definition:
      'No clear risk-on or risk-off lean — the underlying signals point in different directions.',
  },
};

export const lookupBias = makeLookup(BIAS, { label: 'Unknown', definition: 'Not reported.' });

/** apps/api/src/pipeline/market.ts `breadthLabel()`, plus the 'unknown' empty-data fallback. */
export const BREADTH_LABEL: Record<string, CopyEntry> = {
  'broad-risk-on': {
    label: 'Broadly up',
    definition:
      'A large majority of scanned coins are up over 24h, with the average move confirmed by rising open interest.',
  },
  'selective-risk-on': {
    label: 'Selectively up',
    definition: 'More coins are up than down, but the advance is not broad-based.',
  },
  mixed: {
    label: 'Mixed',
    definition: 'Roughly as many coins are up as down — no clear market-wide lean.',
  },
  'selective-risk-off': {
    label: 'Selectively down',
    definition: 'More coins are down than up, but the decline is not broad-based.',
  },
  'broad-risk-off': {
    label: 'Broadly down',
    definition:
      'A large majority of scanned coins are down over 24h, with the average move confirmed by rising open interest.',
  },
  unknown: {
    label: 'Unknown',
    definition: 'Not enough trusted price data to score market breadth.',
  },
};

export const lookupBreadthLabel = makeLookup(BREADTH_LABEL, {
  label: 'Unknown',
  definition: 'Not reported.',
});

/** market.ts `sectorLabel()`, plus the 'unknown' empty-data fallback. */
export const SECTOR_ROTATION_LABEL: Record<string, CopyEntry> = {
  'broad-sector-bid': {
    label: 'Broad buying across sectors',
    definition: 'Most CoinGecko categories are positive over 24h.',
  },
  'broad-sector-offer': {
    label: 'Broad selling across sectors',
    definition: 'Most CoinGecko categories are negative over 24h.',
  },
  'rotation-dispersed': {
    label: 'Rotating, no clear leader',
    definition:
      'Leading categories are up sharply while lagging categories are down sharply at the same time — money is rotating between sectors, not moving uniformly.',
  },
  'selective-sector-bid': {
    label: 'A few sectors leading',
    definition: 'The leading categories are positive, but the move is not broad-based.',
  },
  'selective-sector-offer': {
    label: 'A few sectors lagging',
    definition: 'The lagging categories are negative, but the move is not broad-based.',
  },
  mixed: {
    label: 'Mixed',
    definition: 'No clear sector leadership either way.',
  },
  unknown: {
    label: 'Unknown',
    definition: 'Not enough category data to score sector rotation.',
  },
};

export const lookupSectorRotationLabel = makeLookup(SECTOR_ROTATION_LABEL, {
  label: 'Unknown',
  definition: 'Not reported.',
});

/**
 * apps/api/src/pipeline/regime.ts `REGIME_STATES` (btc-led/alts-strong/neutral/chaos), plus the
 * legacy 'momentum' label that still appears in the frozen fixture from an earlier model version.
 */
export const REGIME_STATE: Record<string, CopyEntry> = {
  'btc-led': {
    label: 'BTC leading',
    definition:
      "Bitcoin's dominance is rising and/or altcoins are underperforming it — capital is concentrating in BTC.",
  },
  'alts-strong': {
    label: 'Alts strong',
    definition:
      'Altcoins are outperforming Bitcoin and market breadth is strong — capital is spreading into altcoins.',
  },
  neutral: {
    label: 'Neutral',
    definition: 'No dominant regime signal either way.',
  },
  chaos: {
    label: 'Chaotic',
    definition:
      'Returns across coins are unusually dispersed, often with weak breadth or stretched funding — a hard market to read directionally.',
  },
  momentum: {
    label: 'Momentum-led',
    definition: 'Legacy regime label from an earlier model version, kept for old saved runs.',
  },
};

export const lookupRegimeState = makeLookup(REGIME_STATE, {
  label: 'Unknown',
  definition: 'Not reported.',
});

/** apps/api/src/dashboard/freshness.ts `freshnessSummary()` label thresholds. */
export const FRESHNESS: Record<string, CopyEntry> = {
  fresh: { label: 'Fresh', definition: 'This saved run is 4 hours old or less.' },
  aging: { label: 'Aging', definition: 'This saved run is 4-12 hours old.' },
  stale: { label: 'Stale', definition: 'This saved run is 12-24 hours old.' },
  old: {
    label: 'Old',
    definition: 'This saved run is more than 24 hours old — treat it with caution.',
  },
  unknown: {
    label: 'Unknown age',
    definition: "Couldn't determine how old this saved run is.",
  },
};

export const lookupFreshness = makeLookup(FRESHNESS, {
  label: 'Unknown age',
  definition: 'Not reported.',
});

/** apps/api/src/dashboard/payload.ts `calibrationLabel()`. */
export const CALIBRATION: Record<string, CopyEntry> = {
  learning: {
    label: 'Still learning',
    definition:
      "Fewer than 20 tracked outcomes so far (or no hit rate yet) — too early to trust the model's historical accuracy.",
  },
  useful: {
    label: 'Track record: useful',
    definition:
      "Historical hit rate is 58% or higher across tracked outcomes — the model's calls have been right more often than not, by a solid margin.",
  },
  neutral: {
    label: 'Track record: mixed',
    definition:
      "Historical hit rate is 50-58% — roughly a coin flip; the model isn't clearly adding value yet.",
  },
  weak: {
    label: 'Track record: weak',
    definition:
      "Historical hit rate is below 50% — the model's calls have missed more often than they've hit recently.",
  },
};

export const lookupCalibration = makeLookup(CALIBRATION, {
  label: 'Unknown',
  definition: 'Not reported.',
});

// ---------------------------------------------------------------------------------------------
// 8. METRIC -- definitions for column/stat terms so ⓘ tooltips have text. These keys are not
// machine enum values from the API; they're stable ids for the concepts the brief called out.
// ---------------------------------------------------------------------------------------------

export const METRIC: Record<string, CopyEntry> = {
  priority: {
    label: 'Rank',
    definition:
      "Where this row sits in its watchlist, highest first. Combines the model score with data quality and the model's own confidence -- not price or size alone.",
  },
  conviction: {
    label: 'Conviction',
    definition:
      "The model's confidence score, 0-100. Combines how strong the driving factors are, data quality, liquidity, and whether the 4h chart agrees with the direction.",
  },
  data_quality: {
    label: 'Data quality',
    definition:
      "0-100 score based on how many sanity checks this coin's data failed; each failed check costs 25 points. Below 100 means at least one check failed.",
  },
  funding: {
    label: 'Funding',
    definition:
      'The perpetual funding rate. Positive usually means longs pay shorts; negative usually means shorts pay longs.',
  },
  open_interest: {
    label: 'Open interest',
    definition:
      'Total dollar value of open futures positions on this contract. Rising open interest alongside rising price usually means new money is entering, not just existing positions changing hands.',
  },
  long_short_ratio: {
    label: 'Long/short ratio',
    definition:
      'Ratio of accounts (or volume) positioned long vs short on this contract. Above 1 leans long, below 1 leans short.',
  },
  crowding: {
    label: 'Crowding',
    definition:
      'How one-sided current leveraged positioning is, based on funding and the long/short ratio. High long crowding raises the odds of a long unwind; high short crowding raises squeeze risk.',
  },
  change_24h: {
    label: '24h change',
    definition: 'Spot or mark price change over the last 24 hours.',
  },
  breadth: {
    label: 'Breadth',
    definition:
      'The share of scanned coins moving up vs down over 24h, weighted by the size of the move and confirmed by open interest. Broad means most coins agree; selective/narrow means only a few are moving.',
  },
  btc_dominance: {
    label: 'BTC dominance',
    definition:
      "Bitcoin's share of total crypto market cap. A rising share means capital is concentrating in BTC relative to altcoins.",
  },
  eth_dominance: {
    label: 'ETH dominance',
    definition:
      "Ethereum's share of total crypto market cap. ETH dominance rising while BTC dominance falls is the classic sign of capital rotating out of Bitcoin and down the risk curve into altcoins.",
  },
  volatility: {
    label: 'Volatility',
    definition:
      'The median 14-period Average True Range (as a percent of price) across all scanned coins -- a market-wide read on how much coins are swinging, independent of direction.',
  },
  regime: {
    label: 'Regime',
    definition:
      "The model's read on what's driving the market: BTC-led, alts strong, neutral, or chaotic. Recomputed on every run from price dispersion, BTC dominance, and breadth.",
  },
  bias: {
    label: 'Bias',
    definition:
      'Whether overall conditions favor risk-taking (risk-on), caution (risk-off), or neither clearly (mixed).',
  },
};

export const lookupMetric = makeLookup(METRIC, NOT_REPORTED);

// ---------------------------------------------------------------------------------------------
// DATA_QUALITY_FLAG -- apps/api/src/pipeline/quality.ts `dataQualityFlags()` (13 codes). Most
// carry a dynamic `code:value` suffix -- lookupQualityFlag() splits on the first ':' and keys on
// the prefix, so a suffixed flag never falls through to the raw fallback. This is the single
// source of truth; apps/web/components/QualityFlagChip.tsx renders from it directly.
// ---------------------------------------------------------------------------------------------

export const DATA_QUALITY_FLAG: Record<string, CopyEntry> = {
  missing_symbol: {
    label: 'Missing symbol',
    definition: 'The row has no coin symbol — excluded until fixed.',
  },
  missing_contract_symbol: {
    label: 'Missing contract',
    definition: 'The row has no futures contract symbol — excluded until fixed.',
  },
  weird_symbol: {
    label: 'Odd symbol',
    definition: 'The symbol contains unexpected characters.',
  },
  weird_contract_symbol: {
    label: 'Odd contract',
    definition: "The contract symbol doesn't look like it matches the coin's quote asset.",
  },
  invalid_price: {
    label: 'Invalid price',
    definition: 'Price is missing, zero, or negative.',
  },
  stale_low_quote_volume: {
    label: 'Low volume',
    definition: '24h quote volume is below the minimum required to trust this row.',
  },
  extreme_24h_price_change: {
    label: 'Extreme 24h price move',
    definition:
      'The 24h price change is implausibly large — likely a data error rather than a real move.',
  },
  extreme_24h_oi_change: {
    label: 'Extreme 24h OI move',
    definition: 'The 24h open-interest change is implausibly large — likely a data error.',
  },
  extreme_24h_volume_change: {
    label: 'Extreme 24h volume move',
    definition: 'The 24h volume change is implausibly large — likely a data error.',
  },
  extreme_funding_rate: {
    label: 'Extreme funding rate',
    definition: 'The funding rate is outside a plausible range — likely a data error.',
  },
  invalid_open_interest: {
    label: 'Invalid open interest',
    definition: 'Open interest is negative, which should never happen.',
  },
  price_deviates_from_index: {
    label: 'Price vs index mismatch',
    definition:
      "This exchange's price differs too much from the index price across exchanges — possible bad tick or thin market.",
  },
  thin_coinglass_exchange_coverage: {
    label: 'Thin exchange coverage',
    definition: 'Too few exchanges report this contract to trust the aggregated numbers.',
  },
};

export interface QualityFlagCopy extends CopyEntry {
  readonly detail: string;
}

function qualityFlagDetail(code: string, value: string): string {
  switch (code) {
    case 'weird_symbol':
      return `Symbol: "${value}"`;
    case 'weird_contract_symbol':
      return `Contract: "${value}"`;
    case 'extreme_24h_price_change':
      return `Price moved ${value} in 24h — looks wrong.`;
    case 'extreme_24h_oi_change':
      return `Open interest moved ${value} in 24h — looks wrong.`;
    case 'extreme_24h_volume_change':
      return `Volume moved ${value} in 24h — looks wrong.`;
    case 'extreme_funding_rate':
      return `Funding rate reads ${value} — looks wrong.`;
    case 'price_deviates_from_index':
      return `Price is ${value} off the index price.`;
    case 'thin_coinglass_exchange_coverage':
      return `Only ${value} exchange(s) report this contract.`;
    default:
      return value;
  }
}

/** Splits `code` or `code:value` and resolves the prefix, so a dynamic suffix never leaks raw. */
export function lookupQualityFlag(flag: string): QualityFlagCopy {
  const separatorIndex = flag.indexOf(':');
  const code = separatorIndex === -1 ? flag : flag.slice(0, separatorIndex);
  const value = separatorIndex === -1 ? '' : flag.slice(separatorIndex + 1);
  const entry = DATA_QUALITY_FLAG[code] ?? unknownEntry(code);
  return { ...entry, detail: value ? qualityFlagDetail(code, value) : '' };
}
