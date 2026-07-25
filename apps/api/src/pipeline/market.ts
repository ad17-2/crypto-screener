import {
  clamp,
  mean,
  meanOrNull,
  median,
  numericValues,
  pyRound,
  stdev,
  toFloat,
  weightedAverage,
} from './scoring.js';
import { asArray, asRecord, type MarketContext, type Row } from './types.js';

function trustedRows(rows: Row[]): Row[] {
  return rows.filter((row) => row.is_trusted !== false);
}

export function marketSensingSummary(
  rows: Row[],
  marketContext: MarketContext,
  priorMarketState: Record<string, unknown> | null | undefined,
): {
  btc_dominance_delta_pct: number | null;
  eth_btc_performance_pct: number | null;
  return_dispersion_pct: number | null;
  mean_btc_correlation: number | null;
  alt_alt_mean_correlation: number | null;
  correlation_spread: number | null;
  alt_alt_correlation_pairs: number | null;
} {
  const trusted = trustedRows(rows);
  const currentBtcDom = toFloat(marketContext.btc_dominance_pct);
  const priorBtcDom = toFloat(priorMarketState?.btc_dominance_pct);
  const btcDominanceDeltaPct =
    currentBtcDom !== null && priorBtcDom !== null ? currentBtcDom - priorBtcDom : null;

  const priceChanges = numericValues(trusted.map((row) => row.price_change_24h_pct));
  const returnDispersionPct = priceChanges.length >= 2 ? stdev(priceChanges) : null;

  // Averaged over `trusted`, same as return_dispersion_pct/eth_btc_performance_pct above --
  // btc_correlation is a legitimate per-coin observable already on each row (set by
  // enrichment.ts's appendCoinglassTechnicals), so unlike alt_alt_mean_correlation below it needs
  // no stashed carrier off the BTC row.
  const meanBtcCorrelation = meanOrNull(trusted.map((row) => row.btc_correlation));
  const correlationStructure = correlationStructureSummary(rows);
  const correlationSpread =
    meanBtcCorrelation !== null && correlationStructure.alt_alt_mean_correlation !== null
      ? meanBtcCorrelation - correlationStructure.alt_alt_mean_correlation
      : null;

  return {
    btc_dominance_delta_pct: btcDominanceDeltaPct,
    eth_btc_performance_pct: ethBtcPerformancePct(trusted),
    return_dispersion_pct: returnDispersionPct,
    mean_btc_correlation: meanBtcCorrelation,
    alt_alt_mean_correlation: correlationStructure.alt_alt_mean_correlation,
    correlation_spread: correlationSpread,
    alt_alt_correlation_pairs: correlationStructure.alt_alt_correlation_pairs,
  };
}

/**
 * Reads (and clears) the alt-alt correlation scalars enrichment.ts's appendCoinglassTechnicals
 * stashed on the BTC row -- rows is the only channel that carries them here unmodified through
 * collector.ts/runPipeline.ts, since the raw price series they're derived from aren't retained
 * per-row (see enrichment.ts's own comment on this). Deleting them off the row here keeps the BTC
 * row's persisted row_json free of market-wide fields that aren't actually a BTC fact -- they
 * surface only through this market_context object.
 *
 * Takes the FULL `rows`, not the trusted-filtered set: quality.ts's applyDataQuality runs AFTER
 * enrichment, so by the time this runs BTC's own row can be flagged untrusted for the cycle.
 * Finding against a trusted-filtered array would then miss the real BTC row object, so the delete
 * would never run -- these market-wide fields would ship inside BTC's persisted row_json instead
 * (db/runs.ts stringifies the whole row with no allowlist) and market_context would render null.
 * The find-and-delete happens unconditionally on whatever BTC row exists, independent of its trust
 * status for this cycle.
 *
 * Display-only, like the rest of this file's return object: a rival screener renders a correlation
 * minimum-spanning-tree over the coin universe and reads its topology (a "star" -- every coin hangs
 * directly off BTC -- means no genuine diversification is available); these scalars carry the same
 * information without a graph. Nothing here feeds scoring or watchlist membership -- it joins
 * regime/fear-greed/macro as an honest, unvalidated observable.
 */
function correlationStructureSummary(rows: Row[]): {
  alt_alt_mean_correlation: number | null;
  alt_alt_correlation_pairs: number | null;
} {
  const btcRow = rows.find((row) => row.symbol === 'BTC');
  const summary = {
    alt_alt_mean_correlation: toFloat(btcRow?.alt_alt_mean_correlation),
    alt_alt_correlation_pairs: toFloat(btcRow?.alt_alt_correlation_pairs),
  };
  if (btcRow) {
    delete btcRow.alt_alt_mean_correlation;
    delete btcRow.alt_alt_correlation_pairs;
  }
  return summary;
}

function ethBtcPerformancePct(rows: Row[]): number | null {
  let btcChange: number | null = null;
  let ethChange: number | null = null;
  for (const row of rows) {
    if (row.symbol === 'BTC') {
      btcChange = toFloat(row.price_change_24h_pct);
    } else if (row.symbol === 'ETH') {
      ethChange = toFloat(row.price_change_24h_pct);
    }
  }
  if (btcChange === null || ethChange === null) {
    return null;
  }
  return ((1.0 + ethChange / 100.0) / (1.0 + btcChange / 100.0) - 1.0) * 100.0;
}

export function marketStructureSummary(
  rows: Row[],
  marketContext: MarketContext,
  screenerSectors: ScreenerSectorRotationEntry[] = [],
  preferScreenerSectors = true,
): { breadth: Record<string, unknown>; sector_rotation: Record<string, unknown> } {
  const trusted = trustedRows(rows);
  return {
    breadth: breadthSummary(trusted, marketContext, screenerSectors, preferScreenerSectors),
    sector_rotation: sectorRotationSummary(marketContext),
  };
}

function breadthSummary(
  rows: Row[],
  marketContext: MarketContext,
  screenerSectors: ScreenerSectorRotationEntry[],
  preferScreenerSectors: boolean,
): Record<string, unknown> {
  const priceChanges = numericValues(rows.map((row) => row.price_change_24h_pct));
  const oiChanges = numericValues(rows.map((row) => row.oi_change_24h_pct));
  const fundingValues = numericValues(rows.map((row) => row.funding_rate_pct));
  const weightedReturn = volumeWeightedReturn(rows);

  // The breadth score's category-momentum input (0.14 weight below): screenerSectorRotation()'s
  // screener-aligned sector medians (the screener's own ~70-coin universe) when available and
  // preferred (config factors.prefer_screener_sector_momentum, default true), else the legacy
  // CoinGecko-global-category score. Falls back cleanly -- never a misleading 0 -- when either or
  // both sources are unavailable/empty; category_momentum_source below always says which one
  // actually fed the weight, mirroring the briefing's used_tools field, so a silent switch between
  // the two never becomes undiagnosable.
  const screenerScore = screenerSectorMomentumScore(screenerSectors);
  const categoryScore = categoryMomentumScore(marketContext);
  let categoryMomentumSource: 'screener_sectors' | 'coingecko_categories' | 'none';
  let categoryScoreUsed: number | null;
  if (preferScreenerSectors && screenerScore !== null) {
    categoryScoreUsed = screenerScore;
    categoryMomentumSource = 'screener_sectors';
  } else if (categoryScore !== null) {
    categoryScoreUsed = categoryScore;
    categoryMomentumSource = 'coingecko_categories';
  } else {
    categoryScoreUsed = null;
    categoryMomentumSource = 'none';
  }

  if (priceChanges.length === 0) {
    return {
      status: 'empty',
      label: 'unknown',
      score: 0.0,
      advancers: 0,
      decliners: 0,
      sample_size: 0,
    };
  }

  const advancers = priceChanges.filter((value) => value > 0).length;
  const decliners = priceChanges.filter((value) => value < 0).length;
  const unchanged = priceChanges.length - advancers - decliners;
  const advancerPct = (advancers / priceChanges.length) * 100.0;
  const declinerPct = (decliners / priceChanges.length) * 100.0;
  const priceBreadthScore = (advancerPct - declinerPct) / 100.0;
  const avgReturn = mean(priceChanges);
  const avgReturnScore = clamp(avgReturn / 4.0, -1.0, 1.0);
  const weightedReturnScore = clamp((weightedReturn ?? avgReturn) / 4.0, -1.0, 1.0);

  const oiExpanders = oiChanges.filter((value) => value > 0).length;
  const oiExpanderPct = oiChanges.length > 0 ? (oiExpanders / oiChanges.length) * 100.0 : null;
  const oiConfirmationScore =
    oiExpanderPct !== null
      ? priceBreadthScore * clamp((oiExpanderPct - 50.0) / 50.0, -1.0, 1.0)
      : 0.0;

  const scoreParts = [
    priceBreadthScore * 0.4,
    avgReturnScore * 0.18,
    weightedReturnScore * 0.18,
    oiConfirmationScore * 0.1,
  ];
  if (categoryScoreUsed !== null) {
    scoreParts.push(categoryScoreUsed * 0.14);
  }
  const score = clamp(
    scoreParts.reduce((sum, value) => sum + value, 0),
    -1.0,
    1.0,
  );

  return {
    status: 'ok',
    label: breadthLabel(score, advancerPct),
    score: pyRound(score, 3),
    advancers,
    decliners,
    unchanged,
    sample_size: priceChanges.length,
    advancer_pct: pyRound(advancerPct, 2),
    decliner_pct: pyRound(declinerPct, 2),
    avg_return_24h_pct: pyRound(avgReturn, 3),
    volume_weighted_return_24h_pct: weightedReturn !== null ? pyRound(weightedReturn, 3) : null,
    oi_expander_pct: oiExpanderPct !== null ? pyRound(oiExpanderPct, 2) : null,
    avg_funding_rate_pct: fundingValues.length > 0 ? pyRound(mean(fundingValues), 5) : null,
    category_momentum_score: categoryScoreUsed !== null ? pyRound(categoryScoreUsed, 3) : null,
    category_momentum_source: categoryMomentumSource,
  };
}

function sectorRotationSummary(marketContext: MarketContext): Record<string, unknown> {
  const categories = asRecord(marketContext.categories);
  const leaders = asArray(categories.leaders);
  const laggards = asArray(categories.laggards);
  const leaderValues = categoryChanges(leaders.slice(0, 5));
  const laggardValues = categoryChanges(laggards.slice(0, 5));
  if (leaderValues.length === 0 && laggardValues.length === 0) {
    return { status: 'empty', label: 'unknown' };
  }

  const leaderAvg = leaderValues.length > 0 ? mean(leaderValues) : null;
  const laggardAvg = laggardValues.length > 0 ? mean(laggardValues) : null;
  const spread = leaderAvg !== null && laggardAvg !== null ? leaderAvg - laggardAvg : null;
  const combined = [...leaderValues, ...laggardValues];
  const positivePct =
    combined.length > 0
      ? (combined.filter((value) => value > 0).length / combined.length) * 100.0
      : null;

  return {
    status: 'ok',
    label: sectorLabel(leaderAvg, laggardAvg, positivePct),
    leader_avg_24h_pct: leaderAvg !== null ? pyRound(leaderAvg, 3) : null,
    laggard_avg_24h_pct: laggardAvg !== null ? pyRound(laggardAvg, 3) : null,
    leader_laggard_spread_pct: spread !== null ? pyRound(spread, 3) : null,
    positive_category_pct: positivePct !== null ? pyRound(positivePct, 2) : null,
  };
}

export interface ScreenerSectorRotationEntry {
  sector: string;
  median_residual_change_24h_pct: number;
  n: number;
}

/**
 * Sector rotation computed from the screener's OWN ~70-coin universe, not sectorRotationSummary's
 * CoinGecko categories above -- those categories describe a universe the user doesn't trade (see
 * f74b9fc's liquidity floor and the "align the sector with the screener" ask that followed it).
 * `sectorMembers` is `sector label -> member symbols`, built by collector.ts's
 * collectCoingeckoContext from providers.coingecko.sectors.
 *
 * Uses residual_change_24h_pct (BTC-beta stripped, set by rowScoring.ts's applyScores when both
 * btc_beta and the market's btc_change_24h_pct are known), not price_change_24h_pct: the entire
 * point of building this from our own data is to read genuine relative strength, not everything
 * drifting together with BTC. A row without a residual value is skipped from both the sector's
 * median and its n. `rows` is unfiltered (like marketSensingSummary's own `rows` param above) --
 * trustedRows() is applied internally.
 *
 * A coin can legitimately belong to more than one sector (LINK is both DeFi and AI) -- it counts
 * toward each sector's median independently. That's intentional, not a bug to be deduplicated away.
 *
 * Symbol matching is case-insensitive. A sector whose matched-and-valued member count falls below
 * `minMembers` is dropped entirely -- too thin a sample to read as a sector move. Results sort by
 * median residual descending (strongest rotation first).
 */
export function screenerSectorRotation(
  rows: Row[],
  sectorMembers: Record<string, string[]>,
  minMembers: number,
): ScreenerSectorRotationEntry[] {
  const residualBySymbol = new Map<string, number>();
  for (const row of trustedRows(rows)) {
    const symbol = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
    const residual = toFloat(row.residual_change_24h_pct);
    if (symbol !== null && residual !== null) {
      residualBySymbol.set(symbol, residual);
    }
  }

  const entries: ScreenerSectorRotationEntry[] = [];
  for (const [sector, members] of Object.entries(sectorMembers)) {
    const values = members
      .map((member) => residualBySymbol.get(member.toUpperCase()))
      .filter((value): value is number => value !== undefined);
    if (values.length < minMembers) {
      continue;
    }
    entries.push({
      sector,
      median_residual_change_24h_pct: pyRound(median(values), 3),
      n: values.length,
    });
  }

  return entries.sort(
    (a, b) => b.median_residual_change_24h_pct - a.median_residual_change_24h_pct,
  );
}

function volumeWeightedReturn(rows: Row[]): number | null {
  return weightedAverage(rows, 'price_change_24h_pct', 'quote_volume_usd');
}

function categoryMomentumScore(marketContext: MarketContext): number | null {
  const categories = asRecord(marketContext.categories);
  const values = [
    ...categoryChanges(asArray(categories.leaders).slice(0, 5)),
    ...categoryChanges(asArray(categories.laggards).slice(0, 5)),
  ];
  if (values.length === 0) {
    return null;
  }
  return clamp(mean(values) / 4.0, -1.0, 1.0);
}

function categoryChanges(categories: unknown[]): number[] {
  return numericValues(categories.map((item) => asRecord(item).market_cap_change_24h_pct));
}

/**
 * Screener-aligned analogue of categoryMomentumScore above -- same scaling and clamp, applied to
 * screenerSectorRotation()'s per-sector median residuals instead of CoinGecko's global category
 * changes, so the two are directly comparable and the 0.14 weight breadthSummary applies to
 * whichever one is used still means the same thing. Per-sector median residuals were measured live
 * 2026-07-25 at roughly -2.9% to +0.5% (see config/schema.ts's providers.coingecko.sectors
 * comment) -- well inside the single-digit-percent range /4.0 was sized for, so this does not
 * saturate: a worst-case all-sectors-at--2.9% mean still only clamps to -0.725, not -1.0.
 */
function screenerSectorMomentumScore(entries: ScreenerSectorRotationEntry[]): number | null {
  if (entries.length === 0) {
    return null;
  }
  const values = entries.map((entry) => entry.median_residual_change_24h_pct);
  return clamp(mean(values) / 4.0, -1.0, 1.0);
}

function breadthLabel(score: number, advancerPct: number): string {
  if (score >= 0.35 && advancerPct >= 60.0) {
    return 'broad-risk-on';
  }
  if (score >= 0.15) {
    return 'selective-risk-on';
  }
  if (score <= -0.35 && advancerPct <= 40.0) {
    return 'broad-risk-off';
  }
  if (score <= -0.15) {
    return 'selective-risk-off';
  }
  return 'mixed';
}

function sectorLabel(
  leaderAvg: number | null,
  laggardAvg: number | null,
  positivePct: number | null,
): string {
  if (positivePct !== null && positivePct >= 70.0) {
    return 'broad-sector-bid';
  }
  if (positivePct !== null && positivePct <= 30.0) {
    return 'broad-sector-offer';
  }
  if (leaderAvg !== null && leaderAvg > 1.0 && laggardAvg !== null && laggardAvg < -1.0) {
    return 'rotation-dispersed';
  }
  if (leaderAvg !== null && leaderAvg > 0) {
    return 'selective-sector-bid';
  }
  if (laggardAvg !== null && laggardAvg < 0) {
    return 'selective-sector-offer';
  }
  return 'mixed';
}
