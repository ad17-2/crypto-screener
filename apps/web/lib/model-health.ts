import { arr, num, rec, str } from './payload';
import { asRecord } from './wire';

/**
 * Pure derivations for the /model page. Every input is one of the API's `unknown`-typed payload
 * blobs (quality, validation, model_weights, ...), read defensively via lib/payload.ts accessors
 * so a missing/malformed field degrades to an honest "not enough data" state instead of rendering
 * "null"/"NaN"/"undefined". No React here -- see components/model/* for rendering.
 *
 * Thresholds cited below (ic_min_periods=10, min_abs_t=2.0, regime_min_periods=8,
 * min_observations=30) mirror apps/api's own constants -- see the field-semantics audit this
 * module was built from (apps/api/src/pipeline/weighting.ts, validation.ts, config/default.json).
 * We cannot import them (apps/api is off-limits), so they're restated here with that citation.
 */

// -------------------------------------------------------------------------------------------
// Evidence ladder -- the hero's signature element. Four ascending claims the model would like to
// make; each is only lit if the real data backs it up.
// -------------------------------------------------------------------------------------------

export type RungStatus = 'pass' | 'partial' | 'fail';

export interface EvidenceRung {
  key: 'clean_data' | 'signals_measured' | 'measurements_strong' | 'scored_end_to_end';
  claim: string;
  status: RungStatus;
  detail: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1];
    const hi = sorted[mid];
    return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : null;
  }
  const value = sorted[mid];
  return value ?? null;
}

function cleanDataRung(quality: unknown): EvidenceRung {
  const claim = 'The data going in is clean';
  const trusted = num(quality, 'trusted_count');
  const excluded = num(quality, 'excluded_count');
  if (trusted === null || excluded === null) {
    return {
      key: 'clean_data',
      claim,
      status: 'fail',
      detail: 'No data-quality read for this run.',
    };
  }
  const total = trusted + excluded;
  if (total === 0) {
    return { key: 'clean_data', claim, status: 'fail', detail: 'No rows were scanned this run.' };
  }
  const trustedPct = (trusted / total) * 100;
  const detail =
    excluded > 0
      ? `${trusted} of ${total} coins passed every sanity check (${trustedPct.toFixed(1)}%); ${excluded} excluded.`
      : `All ${trusted} coins passed every sanity check.`;
  const status: RungStatus = trustedPct >= 95 ? 'pass' : trustedPct >= 80 ? 'partial' : 'fail';
  return { key: 'clean_data', claim, status, detail };
}

/** apps/api/src/pipeline/weighting.ts ic_min_periods = 10. */
const IC_MIN_PERIODS = 10;

function signalsMeasuredRung(validation: unknown, factors: unknown[]): EvidenceRung {
  const claim = 'Signals have been measured';
  const observations = num(validation, 'observations');
  const periods = factors
    .map((factor) => num(factor, 'n_periods'))
    .filter((n): n is number => n !== null);
  const maxPeriods = periods.length > 0 ? Math.max(...periods) : null;

  if (observations === null || observations === 0) {
    return {
      key: 'signals_measured',
      claim,
      status: 'fail',
      detail: 'No historical outcomes have been recorded yet.',
    };
  }
  const periodsText = maxPeriods !== null ? ` across ${maxPeriods} time snapshots` : '';
  const detail = `${observations.toLocaleString('en-US')} historical outcomes tracked${periodsText}.`;
  const status: RungStatus =
    maxPeriods !== null && maxPeriods >= IC_MIN_PERIODS ? 'pass' : 'partial';
  return { key: 'signals_measured', claim, status, detail };
}

/** apps/api/src/pipeline/weighting.ts min_abs_t = 2.0 -- the significance bar, now applied to the economic-edge t-stat rather than the rank-IC t-stat. */
const MIN_ABS_T_STAT = 2;

/**
 * "Working" means money, not rank order: a factor only counts here if its decile long-short
 * spread clears a t-stat of 2 AND is still positive after both legs' round-trip costs
 * (net_spread_pct > 0) -- see apps/api/src/pipeline/weighting.ts's net_edge selection gate. A
 * factor with a significant rank IC but a negative net spread does NOT count as passing.
 */
function measurementsStrongRung(factors: unknown[]): EvidenceRung {
  const claim = 'The signals that pass actually make money';
  const total = factors.length;
  if (total === 0) {
    return {
      key: 'measurements_strong',
      claim,
      status: 'fail',
      detail: 'No factor weights are available to check yet.',
    };
  }
  const strongCount = factors.filter((factor) => {
    const t = num(factor, 'edge_t_stat');
    const netSpread = num(factor, 'net_spread_pct');
    return t !== null && Math.abs(t) >= MIN_ABS_T_STAT && netSpread !== null && netSpread > 0;
  }).length;
  const detail = `${strongCount} of ${total} signals are still profitable after both legs' trading costs, with a t-stat of ${MIN_ABS_T_STAT} or more (the usual bar for "probably not noise").`;
  const status: RungStatus =
    strongCount === 0 ? 'fail' : strongCount / total >= 0.5 ? 'pass' : 'partial';
  return { key: 'measurements_strong', claim, status, detail };
}

/** apps/api/src/pipeline/validation.ts min_observations = 30 -- the bar for validation status 'ok'. */
const MIN_MODEL_OBSERVATIONS = 30;

function scoredEndToEndRung(validation: unknown): EvidenceRung {
  const claim = 'The model has been scored end to end';
  const model = rec(validation, 'model');
  const observations = num(model, 'observations');
  if (observations === null || observations === 0) {
    return {
      key: 'scored_end_to_end',
      claim,
      status: 'fail',
      detail: "The model's blended score has never been checked against real outcomes.",
    };
  }
  const hitRate = num(model, 'hit_rate');
  const hitText = hitRate !== null ? ` at a ${hitRate.toFixed(1)}% hit rate` : '';
  const detail = `${observations.toLocaleString('en-US')} scored calls checked against real outcomes${hitText}.`;
  const status: RungStatus = observations >= MIN_MODEL_OBSERVATIONS ? 'pass' : 'partial';
  return { key: 'scored_end_to_end', claim, status, detail };
}

/**
 * Ordered bottom (1) to top (4) -- the claim numbering the brief specifies. Rendering top-to-
 * bottom is a CSS concern (flex-direction: column-reverse), not this function's.
 */
export function evidenceLadder(payload: unknown): EvidenceRung[] {
  const quality = rec(payload, 'quality');
  const validation = rec(payload, 'validation');
  const modelWeights = rec(payload, 'model_weights');
  const factors = arr(modelWeights, 'factors');
  return [
    cleanDataRung(quality),
    signalsMeasuredRung(validation, factors),
    measurementsStrongRung(factors),
    scoredEndToEndRung(validation),
  ];
}

// -------------------------------------------------------------------------------------------
// Hero verdict -- "Can I trust today's ranking?"
// -------------------------------------------------------------------------------------------

export interface FactorWeightMix {
  total: number;
  priorCount: number;
  measuredCount: number;
}

export function factorWeightMix(factors: unknown[]): FactorWeightMix {
  let priorCount = 0;
  let measuredCount = 0;
  for (const factor of factors) {
    if (str(factor, 'mode') === 'ic') measuredCount += 1;
    else priorCount += 1;
  }
  return { total: factors.length, priorCount, measuredCount };
}

export interface ModelHealthVerdict {
  headline: string;
  summary: string;
}

/**
 * Share of prior-driven factors at or above which the verdict reads "hasn't proven itself yet"
 * rather than "partway to proving itself" -- a UI framing choice, not an apps/api constant. Chosen
 * so that one factor clearing the significance gate out of twelve doesn't flip the headline from
 * an honest "still running on priors" to an overly rosy "partway there".
 */
const PRIOR_MAJORITY_SHARE = 0.75;

export function modelHealthVerdict(payload: unknown): ModelHealthVerdict {
  const modelWeights = rec(payload, 'model_weights');
  const factors = arr(modelWeights, 'factors');
  const mix = factorWeightMix(factors);
  const ladder = evidenceLadder(payload);
  const scored = ladder.find((rung) => rung.key === 'scored_end_to_end');

  if (mix.total === 0) {
    return {
      headline: "There's nothing to judge yet.",
      summary: 'This run has no factor weights to evaluate.',
    };
  }

  if (scored?.status === 'pass') {
    return {
      headline: 'The model has a real track record.',
      summary:
        "Its blended score has been checked against real outcomes enough times to judge — today's ranking carries more than a starting guess, though it still deserves a chart check before you act.",
    };
  }

  if (mix.priorCount === 0) {
    return {
      headline: "The model's weights are measured, but unproven end to end.",
      summary: `All ${mix.total} signals now have their own measured track record instead of a starting guess, but the model's combined score has never been checked against real outcomes end to end. Treat today's list as a well-informed shortlist, not a proven signal.`,
    };
  }

  // A strong majority, not literally every factor, still reads honestly as "hasn't proven
  // itself" -- the sentence below cites the real count either way, so relaxing this from exact
  // equality doesn't overstate anything. Without this, one measured factor out of twelve (e.g.
  // a single factor that cleared the significance gate, even a small/inverted one) would tip the
  // headline into the much rosier "partway" branch below, which overstates how far along the
  // model actually is.
  if (mix.priorCount / mix.total >= PRIOR_MAJORITY_SHARE) {
    const periods = factors.map((f) => num(f, 'n_periods')).filter((n): n is number => n !== null);
    const nPeriods = median(periods);
    const snapshotsClause = nPeriods !== null ? ` across ${nPeriods} snapshots` : '';
    return {
      headline: "The model hasn't proven itself yet.",
      summary: `It has measured all ${mix.total} signals${snapshotsClause} — but only ${mix.measuredCount} of ${mix.total} produced an edge strong enough to separate from noise. The other ${mix.priorCount} fall back to priors: starting beliefs about what should work. Treat today's list as a shortlist to research, not a signal to trade.`,
    };
  }

  return {
    headline: 'The model is partway to proving itself.',
    summary: `${mix.measuredCount} of ${mix.total} signals now have a measured track record; the other ${mix.priorCount} are still running on starting guesses, and the model's combined score has never been checked end to end. Treat today's list as a lead, not a signal.`,
  };
}

// -------------------------------------------------------------------------------------------
// Stage 2 -- "What the model is betting on" (per-factor weights, ranked).
// -------------------------------------------------------------------------------------------

export interface DecayPoint {
  horizonHours: number;
  meanIc: number | null;
  insufficient: boolean;
}

export interface FactorDecayInfo {
  sufficient: boolean;
  holdsHours: number | null;
  peakHorizonHours: number | null;
  curve: DecayPoint[];
}

export interface FactorHealthRow {
  name: string;
  weight: number | null;
  mode: 'measured' | 'prior';
  ic: number | null;
  tStat: number | null;
  nPeriods: number;
  credibilityK: number | null;
  oosIc: number | null;
  robustness: string | null;
  decay: FactorDecayInfo;
  /** Decile long-short spread net of round-trip costs -- the money number behind the net_edge selection gate. */
  netSpreadPct: number | null;
  netEdgePer30dPct: number | null;
  edgeTStat: number | null;
}

function factorDecayInfo(entry: Record<string, unknown> | null): FactorDecayInfo {
  const curveRaw = arr(entry, 'curve');
  return {
    sufficient: entry !== null && entry.sufficient === true,
    holdsHours: num(entry, 'holds_hours'),
    peakHorizonHours: num(entry, 'peak_horizon_hours'),
    curve: curveRaw.map((point) => ({
      horizonHours: num(point, 'horizon_hours') ?? 0,
      meanIc: num(point, 'mean_ic'),
      insufficient: asRecord(point).insufficient === true,
    })),
  };
}

/** Sorted by |weight| descending, largest bet first -- nulls sort last. */
export function factorHealthRows(modelWeights: unknown): FactorHealthRow[] {
  const factors = arr(modelWeights, 'factors');
  const decayTable = rec(modelWeights, 'factor_decay') ?? {};
  const rows: FactorHealthRow[] = factors.map((factor) => {
    const name = str(factor, 'name') ?? '';
    return {
      name,
      weight: num(factor, 'weight'),
      mode: str(factor, 'mode') === 'ic' ? 'measured' : 'prior',
      ic: num(factor, 'ic'),
      tStat: num(factor, 't_stat'),
      nPeriods: num(factor, 'n_periods') ?? 0,
      credibilityK: num(factor, 'credibility_k'),
      oosIc: num(factor, 'oos_ic'),
      robustness: str(factor, 'robustness'),
      decay: factorDecayInfo(rec(decayTable, name)),
      netSpreadPct: num(factor, 'net_spread_pct'),
      netEdgePer30dPct: num(factor, 'net_edge_per_30d_pct'),
      edgeTStat: num(factor, 'edge_t_stat'),
    };
  });
  return rows.sort((a, b) => Math.abs(b.weight ?? 0) - Math.abs(a.weight ?? 0));
}

/** The single most interesting fact on the page: factors the model weighted negatively. */
export function negativeWeightRows(rows: FactorHealthRow[]): FactorHealthRow[] {
  return rows.filter((row) => row.weight !== null && row.weight < 0);
}

// -------------------------------------------------------------------------------------------
// Stage 3 -- "Is it working?" (hit rates, decay, walk-forward).
// -------------------------------------------------------------------------------------------

export interface FactorHitRate {
  name: string;
  hitRate: number | null;
  observations: number | null;
}

/** Sorted by hit rate descending; factors with no hit rate sort last. */
export function factorHitRates(validation: unknown): FactorHitRate[] {
  const table = rec(validation, 'factors') ?? {};
  return Object.keys(table)
    .map((name) => {
      const entry = rec(table, name);
      return {
        name,
        hitRate: num(entry, 'hit_rate'),
        observations: num(entry, 'observations'),
      };
    })
    .sort((a, b) => (b.hitRate ?? -Infinity) - (a.hitRate ?? -Infinity));
}

export interface DecaySummary {
  sufficientCount: number;
  totalCount: number;
  medianPeakHours: number | null;
  /** Count of sufficientCount factors that actually faded to half strength within the tested window (holds_hours is non-null for these; see holdsFactorCount doc below). */
  holdsFactorCount: number;
  medianHoldsHours: number | null;
}

/**
 * apps/api/src/pipeline/validation.ts factorDecay(): "sufficient" needs >=1 of 6 horizons to
 * qualify. medianPeakHours and medianHoldsHours are deliberately reported as two SEPARATE
 * medians over two different subsets, not one flowing "peaks at X, fades by Y" timeline --
 * holds_hours is null for any factor whose signal never faded to half strength within the
 * 72h window tested (see holdsFactorCount), so mixing the two medians into a single sentence
 * can put the "fade" median before the "peak" median for real data. Callers must not imply a
 * single timeline; report holdsFactorCount alongside medianHoldsHours so the reader knows it's
 * scoped to a subset.
 */
export function decaySummary(modelWeights: unknown): DecaySummary {
  const table = rec(modelWeights, 'factor_decay') ?? {};
  const names = Object.keys(table);
  const sufficientEntries = names
    .map((name) => rec(table, name))
    .filter(
      (entry): entry is Record<string, unknown> => entry !== null && entry.sufficient === true,
    );
  const peaks = sufficientEntries
    .map((entry) => num(entry, 'peak_horizon_hours'))
    .filter((n): n is number => n !== null);
  const holds = sufficientEntries
    .map((entry) => num(entry, 'holds_hours'))
    .filter((n): n is number => n !== null);
  return {
    sufficientCount: sufficientEntries.length,
    totalCount: names.length,
    medianPeakHours: median(peaks),
    holdsFactorCount: holds.length,
    medianHoldsHours: median(holds),
  };
}

export interface WalkForwardSummary {
  nTimestamps: number | null;
  trainPeriods: number | null;
  testPeriods: number | null;
  robustCount: number;
  overfitCount: number;
  insufficientCount: number;
  totalCount: number;
}

/**
 * apps/api/src/pipeline/validation.ts walkForward(): test period count is n_timestamps minus the
 * train split, not any single factor's oos_n_periods (those vary per factor by labeling
 * availability -- see the field-semantics audit). robustness counts come from
 * model_weights.factors[].robustness, the same verdict walkForward() computed.
 */
export function walkForwardSummary(modelWeights: unknown): WalkForwardSummary {
  const wf = rec(modelWeights, 'walk_forward');
  const nTimestamps = num(wf, 'n_timestamps');
  const trainPeriods = num(wf, 'train_periods');
  const testPeriods =
    nTimestamps !== null && trainPeriods !== null ? nTimestamps - trainPeriods : null;

  const factors = arr(modelWeights, 'factors');
  let robustCount = 0;
  let overfitCount = 0;
  let insufficientCount = 0;
  for (const factor of factors) {
    const verdict = str(factor, 'robustness');
    if (verdict === 'robust') robustCount += 1;
    else if (verdict === 'overfit') overfitCount += 1;
    else insufficientCount += 1;
  }
  return {
    nTimestamps,
    trainPeriods,
    testPeriods,
    robustCount,
    overfitCount,
    insufficientCount,
    totalCount: factors.length,
  };
}

// -------------------------------------------------------------------------------------------
// Stage 4 -- "What could be wrong" (collinearity, regime-IC, out-of-sample IC).
// -------------------------------------------------------------------------------------------

export interface CollinearityRisk {
  a: string;
  b: string;
  rho: number | null;
  verdict: string | null;
  /** (|weight_a| + |weight_b|) / sum(|weight_i|) * 100 -- how much total weight this pair shares. */
  combinedWeightPct: number | null;
  /** 1-indexed rank by |weight| descending; null if the factor name wasn't found in factors[]. */
  aRank: number | null;
  bRank: number | null;
}

export function collinearityRisks(modelWeights: unknown): CollinearityRisk[] {
  const factors = arr(modelWeights, 'factors');
  const weightByName = new Map<string, number>();
  for (const factor of factors) {
    const name = str(factor, 'name');
    if (name !== null) weightByName.set(name, num(factor, 'weight') ?? 0);
  }
  const totalAbsWeight = [...weightByName.values()].reduce((sum, w) => sum + Math.abs(w), 0);
  const rankedNames = [...weightByName.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([name]) => name);
  const rankByName = new Map(rankedNames.map((name, index) => [name, index + 1]));

  return arr(modelWeights, 'factor_correlations').map((pair) => {
    const a = str(pair, 'a') ?? 'unknown';
    const b = str(pair, 'b') ?? 'unknown';
    const weightA = weightByName.get(a);
    const weightB = weightByName.get(b);
    const combinedWeightPct =
      weightA !== undefined && weightB !== undefined && totalAbsWeight > 0
        ? ((Math.abs(weightA) + Math.abs(weightB)) / totalAbsWeight) * 100
        : null;
    return {
      a,
      b,
      rho: num(pair, 'rho'),
      verdict: str(pair, 'verdict'),
      combinedWeightPct,
      aRank: rankByName.get(a) ?? null,
      bRank: rankByName.get(b) ?? null,
    };
  });
}

export interface RegimeIcSummary {
  activeCount: number;
  totalCount: number;
  typicalPeriods: number | null;
  regimeLabel: string | null;
}

/** apps/api/src/pipeline/weighting.ts regime_min_periods = 8 -- the bar a regime needs to clear before regime-IC is trusted over the pooled number. */
export const REGIME_MIN_PERIODS = 8;

export function regimeIcSummary(modelWeights: unknown): RegimeIcSummary {
  const regime = rec(modelWeights, 'regime');
  const activeFactors = arr(regime, 'factors_using_regime_ic');
  const factors = arr(modelWeights, 'factors');
  const periodsTable = rec(regime, 'regime_n_periods') ?? {};
  const periods = Object.keys(periodsTable)
    .map((name) => num(periodsTable, name))
    .filter((n): n is number => n !== null);
  return {
    activeCount: activeFactors.length,
    totalCount: factors.length,
    typicalPeriods: median(periods),
    regimeLabel: str(regime, 'label'),
  };
}

export interface OosIcSummary {
  negativeCount: number;
  totalCount: number;
}

export function oosIcSummary(modelWeights: unknown): OosIcSummary {
  const factors = arr(modelWeights, 'factors');
  let negativeCount = 0;
  let totalCount = 0;
  for (const factor of factors) {
    const oosIc = num(factor, 'oos_ic');
    if (oosIc === null) continue;
    totalCount += 1;
    if (oosIc < 0) negativeCount += 1;
  }
  return { negativeCount, totalCount };
}
