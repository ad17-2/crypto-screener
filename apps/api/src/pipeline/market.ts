import {
  clamp,
  mean,
  meanOrNull,
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
): { breadth: Record<string, unknown>; sector_rotation: Record<string, unknown> } {
  const trusted = trustedRows(rows);
  return {
    breadth: breadthSummary(trusted, marketContext),
    sector_rotation: sectorRotationSummary(marketContext),
  };
}

function breadthSummary(rows: Row[], marketContext: MarketContext): Record<string, unknown> {
  const priceChanges = numericValues(rows.map((row) => row.price_change_24h_pct));
  const oiChanges = numericValues(rows.map((row) => row.oi_change_24h_pct));
  const fundingValues = numericValues(rows.map((row) => row.funding_rate_pct));
  const weightedReturn = volumeWeightedReturn(rows);
  const categoryScore = categoryMomentumScore(marketContext);

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
  if (categoryScore !== null) {
    scoreParts.push(categoryScore * 0.14);
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
    category_momentum_score: categoryScore !== null ? pyRound(categoryScore, 3) : null,
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
