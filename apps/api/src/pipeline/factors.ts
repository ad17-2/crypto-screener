import { DIRECTIONAL_FACTORS, QUALITY_FACTORS } from './factorDefinitions.js';
import { marketSensingSummary, marketStructureSummary } from './market.js';
import { type InferredRegime, inferRegime } from './regime.js';
import { applyExcludedScores, applyScores } from './rowScoring.js';
import {
  copysign,
  median,
  olsResiduals,
  robustZscoreByKey,
  safeLog10,
  toFloat,
} from './scoring.js';
import type { FactorRecord, MarketContext, PipelineConfig, Row } from './types.js';
import { asRecord } from './types.js';

export interface ScoreSnapshotResult {
  rows: Row[];
  market_context: MarketContext;
  regime: InferredRegime;
}

/**
 * Mutates every row in `rows` in place. `historyRecords` is accepted but unused: the factor
 * weighting/IC engine that used to consume it was deleted (no factor forward-validated -- see
 * CLAUDE.md's purge/simplify-screener notes). Kept in the signature for call-site parity with the
 * golden parity fixture (tests/parity.test.ts, scripts/regen-golden.ts), which still ships a
 * frozen `factor_history` array.
 */
export function scoreSnapshot(
  rows: Row[],
  marketContext: MarketContext,
  _historyRecords: FactorRecord[],
  config: PipelineConfig,
  priorMarketState?: Record<string, unknown> | null,
): ScoreSnapshotResult {
  const trustedRows = rows.filter((row) => row.is_trusted !== false);
  const enrichedContext: MarketContext = { ...(marketContext ?? {}) };
  Object.assign(enrichedContext, marketStructureSummary(trustedRows, enrichedContext));
  Object.assign(
    enrichedContext,
    marketSensingSummary(trustedRows, enrichedContext, priorMarketState),
  );
  const validAtr = trustedRows
    .map((row) => toFloat(row.atr_14_pct))
    .filter((value): value is number => value !== null);
  enrichedContext.median_atr_pct = validAtr.length > 0 ? median(validAtr) : null;

  // BTC's own state, for the fights-BTC veto in rowScoring.ts: prefer BTC's own row (it carries
  // technicals already; see collector.ts's appendCoinglassTechnicals, which runs before
  // scoreSnapshot), fall back to the coingecko-derived context field, else null.
  const btcRow = trustedRows.find((row) => row.symbol === 'BTC');
  enrichedContext.btc_change_24h_pct = btcRow
    ? toFloat(btcRow.price_change_24h_pct)
    : toFloat(marketContext.btc_price_change_24h_pct);
  enrichedContext.btc_momentum_score = btcRow ? toFloat(btcRow.technical_momentum_score) : null;

  const rawFactorsList = trustedRows.map((row) => rawFactors(row, trustedRows, enrichedContext));
  const factorCfg = config.factors ?? {};
  if (factorCfg.residualise_collinear_factors ?? true) {
    // Must run on raw values before normalizeFactors' robust Z-score, so the OLS fit sees actual
    // economic units instead of median/MAD-winsorized ranks.
    residualiseOiPriceSignal(rawFactorsList, factorCfg.ic_min_cross_section ?? 5);
  }
  const normalized = normalizeFactors(rawFactorsList);
  const priorState = (asRecord(priorMarketState).regime_state as string | undefined) ?? null;
  const regime = inferRegime(undefined, trustedRows, enrichedContext, priorState, config);

  trustedRows.forEach((row, index) => {
    const raw = rawFactorsList[index] as Record<string, number | null>;
    const factors = normalized[index] as Record<string, number>;
    row.raw_factors = raw;
    row.factors = factors;
    applyScores(row, factors, enrichedContext, config);
  });

  for (const row of rows) {
    if (row.is_trusted !== false) {
      continue;
    }
    row.raw_factors = {};
    row.factors = {};
    applyExcludedScores(row);
  }

  return {
    rows,
    market_context: enrichedContext,
    regime,
  };
}

/** `rows` is accepted but currently unused; kept in the signature for call-site stability. */
export function rawFactors(
  row: Row,
  _rows: Row[],
  marketContext: MarketContext,
): Record<string, number | null> {
  const priceChange = toFloat(row.price_change_24h_pct);
  const oiChange = toFloat(row.oi_change_24h_pct);
  const funding = toFloat(row.funding_rate_pct);
  let ls = toFloat(row.long_short_account_ratio);
  if (ls === null) {
    ls = toFloat(row.long_short_ratio);
  }
  const longLiq = toFloat(row.long_liquidation_usd_24h, 0.0) ?? 0.0;
  const shortLiq = toFloat(row.short_liquidation_usd_24h, 0.0) ?? 0.0;
  const quoteVolume = toFloat(row.quote_volume_usd, 0.0) ?? 0.0;
  const depth = toFloat(row.depth_0_5pct_usd, 0.0) ?? 0.0;
  const spread = toFloat(row.spread_bps);
  const volumeChange = toFloat(row.volume_change_percent_24h);
  const technicalTrend = toFloat(row.technical_trend_score);
  const technicalMomentum = toFloat(row.technical_momentum_score);
  const atrPct = toFloat(row.atr_14_pct);
  const oiAcceleration = toFloat(row.oi_acceleration_4h_pct);
  const fundingAvg = toFloat(row.funding_avg_24h_pct);
  const takerImbalance = toFloat(row.taker_imbalance_24h_pct);
  const liquidationImbalance24h = toFloat(row.liquidation_imbalance_24h_pct);

  const liqTotal = longLiq + shortLiq;

  let liquidity = safeLog10(quoteVolume);
  if (depth > 0) {
    liquidity += safeLog10(depth) * 0.25;
  }
  if (spread !== null) {
    liquidity -= Math.min(Math.max(spread, 0.0), 50.0) / 50.0;
  }

  let oiPrice: number | null = null;
  if (priceChange !== null && oiChange !== null) {
    oiPrice = copysign(Math.max(oiChange, 0.0), priceChange);
  }

  let lsContrarian: number | null = null;
  if (ls !== null && ls > 0) {
    lsContrarian = -Math.log(ls);
  }

  let oiAccelerationSignal: number | null = null;
  if (oiAcceleration !== null && priceChange !== null) {
    oiAccelerationSignal = copysign(Math.max(oiAcceleration, 0.0), priceChange);
  }

  const priceChange72h = toFloat(row.price_change_72h_pct);
  let reversal: number | null = null;
  if (priceChange72h !== null) {
    const denom = atrPct !== null ? atrPct : toFloat(marketContext.median_atr_pct);
    const denomOrOne = denom === null || denom === 0 ? 1.0 : denom;
    reversal = -priceChange72h / Math.max(denomOrOne, 1.0);
  }

  return {
    momentum_24h: priceChange,
    reversal_3d: reversal,
    oi_price_signal: oiPrice,
    funding_rate_contrarian: funding !== null ? -funding : null,
    ls_ratio_contrarian: lsContrarian,
    liquidation_imbalance: liqTotal > 0 ? ((shortLiq - longLiq) / liqTotal) * 100.0 : null,
    technical_trend_4h: technicalTrend,
    technical_momentum_4h: technicalMomentum,
    oi_acceleration_signal: oiAccelerationSignal,
    funding_persistence_contrarian: fundingAvg !== null ? -fundingAvg : null,
    taker_flow_24h: takerImbalance,
    liquidation_pressure_24h: liquidationImbalance24h,
    liquidity_30d: quoteVolume > 0 ? liquidity : null,
    volume_expansion_24h: volumeChange,
    volatility_expansion_4h: atrPct,
  };
}

/**
 * oi_price_signal = copysign(max(oiChange, 0), priceChange), so its sign is literally copied from
 * momentum_24h -- structurally collinear unless neutralised. No-ops below minCrossSection rows or
 * when momentum_24h has zero cross-sectional variance.
 */
export function residualiseOiPriceSignal(
  rawRows: Array<Record<string, number | null>>,
  minCrossSection: number,
): void {
  const indices: number[] = [];
  const momentum: number[] = [];
  const oiPrice: number[] = [];
  rawRows.forEach((row, index) => {
    const x = row.momentum_24h;
    const y = row.oi_price_signal;
    if (x !== null && x !== undefined && y !== null && y !== undefined) {
      indices.push(index);
      momentum.push(x);
      oiPrice.push(y);
    }
  });
  if (indices.length < minCrossSection) {
    return;
  }
  const residuals = olsResiduals(momentum, oiPrice);
  if (residuals === null) {
    return;
  }
  indices.forEach((rowIndex, i) => {
    (rawRows[rowIndex] as Record<string, number | null>).oi_price_signal = residuals[i] as number;
  });
}

export function normalizeFactors(
  rawRows: Array<Record<string, number | null>>,
): Array<Record<string, number>> {
  const keys = [...DIRECTIONAL_FACTORS, ...QUALITY_FACTORS];
  const normalized: Array<Record<string, number>> = rawRows.map(() => ({}));
  for (const key of keys) {
    const zscores = robustZscoreByKey(rawRows, key);
    zscores.forEach((score, index) => {
      (normalized[index] as Record<string, number>)[key] = score;
    });
  }
  return normalized;
}
