import { arr, num, pct, rec, signedPct, str } from './payload';

// apps/api/src/pipeline/regime.ts `inferRegime()` -- bias is exactly 'risk-on' | 'risk-off' |
// 'mixed'. 'mixed' and any unrecognized value belong to neither family below, so no divergence
// callout fires for them.
const RISK_ON_BIAS = new Set(['risk-on']);
const RISK_OFF_BIAS = new Set(['risk-off']);

/**
 * The plain-English market read at the top of the dashboard. Pure function, no React -- every
 * input is one of the API's `unknown`-typed payload blobs (regime, market_context, validation,
 * quality), read defensively via lib/payload.ts accessors so a missing field never renders as
 * "null"/"NaN" text.
 */

export interface MarketVerdictInput {
  regime: unknown;
  market_context: unknown;
  validation: unknown;
  /**
   * Not currently used by any headline/summary/fact rule below -- included because the brief
   * that specified this function listed it as an available input. Flagging rather than inventing
   * an unspecified use for it.
   */
  quality: unknown;
}

/** There is no model any more (see CLAUDE.md's purge/simplify-screener notes) -- the summary line is a fixed, honest disclaimer, not a calibration-dependent verdict. */
const SUMMARY = 'These are names to review, not signals.';

export interface MarketVerdict {
  headline: string;
  summary: string;
  facts: string[];
}

function headlineFor(regime: unknown, marketContext: unknown): string {
  const state = str(regime, 'regime_state') ?? str(regime, 'label');
  if (state === 'chaos') return 'Conditions are chaotic.';

  const bias = str(regime, 'bias');
  const breadthLabel = str(rec(marketContext, 'breadth'), 'label');

  if (bias === 'risk-off' && breadthLabel === 'broad-risk-off') {
    return "Risk-off, and it's broad.";
  }
  if (bias === 'risk-off' && (breadthLabel === 'selective-risk-off' || breadthLabel === 'mixed')) {
    return 'Risk-off, but selective.';
  }
  if (bias === 'risk-on' && breadthLabel === 'broad-risk-on') {
    return "Risk-on, and it's broad.";
  }
  if (bias === 'risk-on' && (breadthLabel === 'selective-risk-on' || breadthLabel === 'mixed')) {
    return 'Risk-on, but narrow.';
  }
  if (bias === 'mixed') return 'No clear direction.';
  return 'Mixed conditions.';
}

function sectorFact(marketContext: unknown): string | null {
  const categories = rec(marketContext, 'categories');
  const leader = arr(categories, 'leaders')[0];
  const laggard = arr(categories, 'laggards')[0];
  const leaderName = str(leader, 'name');
  const leaderPct = num(leader, 'market_cap_change_24h_pct');
  const laggardName = str(laggard, 'name');
  const laggardPct = num(laggard, 'market_cap_change_24h_pct');

  if (leaderName !== null && leaderPct !== null && laggardName !== null && laggardPct !== null) {
    return `${leaderName} leads (${signedPct(leaderPct, 1)}), ${laggardName} lags (${signedPct(laggardPct, 1)}).`;
  }
  if (leaderName === null && laggardName === null) {
    return 'No sector is clearly leading.';
  }
  return null;
}

function factsFor(marketContext: unknown, regime: unknown, validation: unknown): string[] {
  const facts: string[] = [];

  const breadth = rec(marketContext, 'breadth');
  const advancers = num(breadth, 'advancers');
  const sampleSize = num(breadth, 'sample_size');
  if (advancers !== null && sampleSize !== null) {
    facts.push(`${advancers} of ${sampleSize} coins are up over 24h.`);
  }

  const sector = sectorFact(marketContext);
  if (sector !== null) facts.push(sector);

  const watchlistCounts = rec(validation, 'watchlist_counts');
  const longCount = num(watchlistCounts, 'long');
  const shortCount = num(watchlistCounts, 'short');
  if (longCount !== null && shortCount !== null) {
    facts.push(`${longCount} long setups vs ${shortCount} short.`);
  }

  const btcChange = num(regime, 'btc_change_24h_pct');
  const dominance = num(marketContext, 'btc_dominance_pct');
  if (btcChange !== null && dominance !== null) {
    facts.push(`BTC ${signedPct(btcChange, 1)} · dominance ${pct(dominance, 1)}.`);
  }

  const fearGreedValue = num(marketContext, 'fear_greed_value');
  const fearGreedClassification = str(marketContext, 'fear_greed_classification');
  if (fearGreedValue !== null && fearGreedClassification !== null) {
    facts.push(`Sentiment: ${fearGreedClassification} (${fearGreedValue}).`);

    const bias = str(regime, 'bias');
    if (fearGreedClassification === 'Extreme Greed' && bias !== null && RISK_OFF_BIAS.has(bias)) {
      facts.push('Crowd is still greedy into a weak tape — contrarian caution.');
    } else if (
      fearGreedClassification === 'Extreme Fear' &&
      bias !== null &&
      RISK_ON_BIAS.has(bias)
    ) {
      facts.push('Extreme fear while the tape holds up — contrarian context for longs.');
    }
  }

  return facts;
}

export function marketVerdict(input: MarketVerdictInput): MarketVerdict {
  return {
    headline: headlineFor(input.regime, input.market_context),
    summary: SUMMARY,
    facts: factsFor(input.market_context, input.regime, input.validation),
  };
}

// sieveStages -- the 4-stage funnel (scanned -> priced -> trusted -> shortlisted) with real
// counts. Labels are honest: the last stage is a top-N cut, never described as "passed".

export interface SieveStage {
  key: 'scanned' | 'priced' | 'trusted' | 'shortlisted';
  count: number;
  label: string;
}

function chartNextRowCount(payload: unknown): number | null {
  const watchlists = arr(payload, 'watchlists');
  const chartNext = watchlists.find((entry) => str(entry, 'id') === 'chart_next');
  return chartNext === undefined ? null : arr(chartNext, 'rows').length;
}

export function sieveStages(payload: unknown): SieveStage[] {
  const coinglassStatus = rec(rec(payload, 'provider_status'), 'coinglass');

  const candidates: Array<{
    key: SieveStage['key'];
    count: number | null;
    label: string;
  }> = [
    { key: 'scanned', count: num(coinglassStatus, 'candidate_symbols'), label: 'Scanned' },
    { key: 'priced', count: num(rec(payload, 'run'), 'row_count'), label: 'Priced' },
    { key: 'trusted', count: num(rec(payload, 'quality'), 'trusted_count'), label: 'Trusted' },
    { key: 'shortlisted', count: chartNextRowCount(payload), label: 'Shortlisted' },
  ];
  return candidates.filter((stage): stage is SieveStage => stage.count !== null);
}
