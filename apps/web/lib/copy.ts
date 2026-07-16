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

// apps/api/src/dashboard/rows.ts `setupLabel()`, built from either a fixed side-based
// string, or `${technical_setup} ${Long|Short}` where technical_setup comes from
// apps/api/src/pipeline/technicals.ts `technicalSetup()` (8 patterns; can also be null when there
// aren't enough candles). Direction (Long/Short) is stripped and handled by the caller (side/tone
// styling elsewhere), not baked into these labels.

/** The only writer of `technical_setup` is `technicalSetup()` in apps/api/src/pipeline/technicals.ts. */
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

/** The non-technical, side-driven setups (plus core/watchlist fallbacks) from `setupLabel()` in apps/api/src/dashboard/rows.ts. */
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
  // The 'Watchlist' fallback in setupLabel() is unreachable dead code, mapped anyway as cheap insurance.
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

export function lookupTechnicalPattern(pattern: string | null | undefined): CopyEntry {
  if (!pattern) return NO_TECHNICAL_READ;
  return TECHNICAL_PATTERN[pattern] ?? unknownEntry(pattern);
}

// apps/api/src/pipeline/factorDefinitions.ts `DIRECTIONAL_FACTORS` (12 live factors)
// plus the 2 RETIRED factors (reversal_1d, btc_relative_strength) that still appear in the frozen
// fixture. QUALITY_FACTORS (liquidity_30d, volume_expansion_24h, volatility_expansion_4h) are
// intentionally excluded: they never reach the payload with a label (they're liquidity/quality
// inputs, not directional drivers shown to the user).

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

// apps/api/src/dashboard/watchlists.ts `WATCHLIST_LABELS` keys (6 ids).
export const WATCHLIST: Record<string, CopyEntry> = {
  chart_next: {
    label: 'Best setups',
    definition:
      'The single best setups across every list, ranked by priority — the top picks for right now.',
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

// Definitions for column/stat terms so ⓘ tooltips have text. These keys are not
// machine enum values from the API; they're stable ids for the concepts the brief called out.
export const METRIC: Record<string, CopyEntry> = {
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
  oi_price_read: {
    label: 'OI / Price',
    definition:
      'How price and open interest moved together over 24h. New longs (both up) = fresh money behind the move; Short covering (price up, OI down) = a weak rally on closing shorts; New shorts (price down, OI up) = fresh downside positioning; Long liquidation (both down) = a washout.',
  },
  crowding: {
    label: 'Crowding',
    definition:
      'How one-sided current leveraged positioning is, based on funding and the long/short ratio. High long crowding raises the odds of a long unwind; high short crowding raises squeeze risk.',
  },
  liquidation_imbalance: {
    label: 'Liq imbalance',
    definition:
      'Net 24h liquidation skew between longs and shorts. Positive means more short positions were liquidated than long (a short squeeze); negative means more longs were liquidated than shorts (a long washout).',
  },
  taker_flow: {
    label: 'Taker flow',
    definition:
      'Net 24h aggressive (taker) buy vs. sell volume imbalance. Positive means aggressive buyers outweighed aggressive sellers; negative means aggressive sellers dominated.',
  },
  btc_correlation: {
    label: 'BTC corr',
    definition:
      "How closely this coin's 4h price moves track BTC's over the last ~30 days (Pearson correlation, −1 to +1). Near +1 = moves with BTC, so a BTC pump can squeeze a short even when the coin's own signal says short; near 0 = decoupled, so its own technicals stand alone.",
  },
  btc_beta: {
    label: 'BTC beta',
    definition:
      'How many percent this coin has moved per 1% BTC move, estimated over ~30 days of 4h bars. Paired with BTC corr, it tells you how hard a BTC move hits this coin.',
  },
  residual_change_24h: {
    label: 'Residual 24h',
    definition:
      "The 24h move left after subtracting the beta-implied BTC move -- the coin's own strength or weakness, independent of what BTC did. This is what the ranking now uses.",
  },
  fights_btc: {
    label: 'Fights BTC',
    definition:
      "This candidate's direction is opposed by a live BTC impulse it's historically correlated to -- the classic fakeout, where BTC is moving against the trade right now.",
  },
  positioning_divergence: {
    label: 'Smart $',
    definition:
      "Top traders' long/short positioning vs. the broader crowd's (top-trader ÷ global account ratio). Above 1 = smart money leans more long than retail; below 1 = the crowd is more long than the pros — a divergence that flags where retail may be offside.",
  },
  top_trader_position_ratio: {
    label: 'Top pos',
    definition:
      "Top traders' long/short ratio weighted by position size rather than headcount -- a whale's position counts more than a shrimp's, unlike the plain account ratio above.",
  },
  top_trader_ratio_delta_24h: {
    label: 'Positioning delta',
    definition:
      '24h change in the top-trader position ratio. Positive means pros have been adding to their lean, negative means cutting it -- pros adding longs into a dump is a different story than a static lean.',
  },
  change_24h: {
    label: '24h change',
    definition: 'Spot or mark price change over the last 24 hours.',
  },
  volume: {
    label: 'Volume',
    definition:
      '24h quote volume traded on the primary exchange -- raw dollar turnover, not a ranking model output.',
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
  // Hardcoded prose, not read from config -- keep in sync with costs.ts / CostsConfigSchema by hand.
  round_trip_cost: {
    label: 'Round-trip cost (est.)',
    definition:
      "An estimated cost to enter and exit this position, not a measured number. Assumes 5bps taker fee and 2bps slippage per fill (both sides = 4x), plus a 2bps spread (used only because the real spread isn't available), plus funding over the model's forward-return horizon at 3 settlements/day -- charged if this side pays it, credited if this side receives it.",
  },
  size_multiplier: {
    label: 'Position size',
    definition:
      "A suggested position size relative to a typical coin, based on this coin's own volatility (14-period ATR) versus the median across trusted coins this run. A calmer-than-typical coin sizes up (up to 2x); a choppier one sizes down (as low as 0.25x) — so a fixed amount of risk buys a similarly-sized bet across very different coins.",
  },
  // GET /api/btc-pulse, polled client-side -- see lib/btc-pulse.ts.
  btc_pulse: {
    label: 'BTC pulse',
    definition:
      "A near-live BTC price, polled about once a minute and compared against BTC's price when this run was computed. A large move since the run means the ranked lists below may already be stale.",
  },
};

export const lookupMetric = makeLookup(METRIC, NOT_REPORTED);

// apps/api/src/pipeline/collector.ts and enrichment.ts `status.<key> = ...`
// assignment sites (6 hardcoded string-literal keys). Two are real external providers
// (coingecko, coinglass); the other four are in-process checks or CoinGlass sub-checks, not
// separate external providers.
export const PROVIDER: Record<string, CopyEntry> = {
  coingecko: {
    label: 'CoinGecko',
    definition: 'External provider: global market cap, dominance, and category data.',
  },
  coinglass: {
    label: 'CoinGlass',
    definition:
      'External provider: the primary futures snapshot (price, open interest, funding, volume) for every tracked pair.',
  },
  data_quality: {
    label: 'Data quality checks',
    definition:
      'Not an external provider -- a local, in-process sanity-check pass that excludes rows failing quality checks.',
  },
  derivatives_history: {
    label: 'Derivatives history',
    definition:
      'A CoinGlass sub-check: historical open interest, funding, liquidation, and taker-flow series, distinct from the live CoinGlass snapshot.',
  },
  long_short_ratio: {
    label: 'Long/short ratio',
    definition: 'A CoinGlass sub-check: global and top-trader long/short account ratio history.',
  },
  technicals: {
    label: 'Technicals',
    definition:
      'A CoinGlass sub-check: OHLC price history used to compute 4h technical indicators.',
  },
};

export const lookupProvider = makeLookup(PROVIDER, NOT_REPORTED);

// apps/api/src/pipeline/quality.ts `dataQualityFlags()` (13 codes). Most
// carry a dynamic `code:value` suffix -- lookupQualityFlag() splits on the first ':' and keys on
// the prefix, so a suffixed flag never falls through to the raw fallback. This is the single
// source of truth; apps/web/components/QualityFlagChip.tsx renders from it directly.
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
  /** The flag's dynamic suffix on its own (e.g. "+1271.84%"), for rendering beside the label. */
  readonly value: string;
  /** The suffix written out as a sentence, for a tooltip -- too long to sit inside a chip. */
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

export function lookupQualityFlag(flag: string): QualityFlagCopy {
  const separatorIndex = flag.indexOf(':');
  const code = separatorIndex === -1 ? flag : flag.slice(0, separatorIndex);
  const value = separatorIndex === -1 ? '' : flag.slice(separatorIndex + 1);
  const entry = DATA_QUALITY_FLAG[code] ?? unknownEntry(code);
  return { ...entry, value, detail: value ? qualityFlagDetail(code, value) : '' };
}
