import { arr, num, rec, str } from './payload';

/**
 * Pure derivations for the /model page. Every input is one of the API's `unknown`-typed payload
 * blobs (quality, validation, model_weights, ...), read defensively via lib/payload.ts accessors
 * so a missing/malformed field degrades to an honest "not enough data" state instead of rendering
 * "null"/"NaN"/"undefined". No React here -- see components/model/* for rendering.
 *
 * Thresholds cited below (ic_min_periods=10, min_observations=30) mirror apps/api's own constants
 * -- see the field-semantics audit this module was built from (apps/api/src/pipeline/weighting.ts,
 * validation.ts, config/default.json). We cannot import them (apps/api is off-limits), so they're
 * restated here with that citation.
 */

// Evidence ladder -- the hero's signature element. Four ascending claims the model would like to
// make; each is only lit if the real data backs it up.

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

/**
 * "Working" means FORWARD-VALIDATED, not merely in-sample profitable: a factor only counts here
 * if it earned money on an earlier slice of history AND still made money when re-checked on a
 * later slice it was never measured from (apps/api/src/pipeline/edgeWalkForward.ts, surfaced per
 * factor as `edge_verdict`). A factor that looked significant and profitable on the training
 * slice but reversed or vanished on the later slice (`failed-forward`) does NOT count as passing
 * -- an in-sample-only bar would have wrongly shipped exactly that factor (see the MEASURED note
 * on technical_trend_4h: train t=+2.20 passes, but validate net -0.030 dies).
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
  const strongCount = factors.filter(
    (factor) => str(factor, 'edge_verdict') === 'validated',
  ).length;
  const detail = `${strongCount} of ${total} signals earned money on an earlier slice of history AND held up when re-checked on a later slice they were never measured from.`;
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

  // Checked before the "scored end to end" branch below on purpose: a good historical hit rate on
  // the model's BLENDED score doesn't change the fact that not one individual factor has earned
  // money on an earlier slice of history AND held up on a later slice it wasn't measured from --
  // that's the more fundamental, more honest thing to say first (see the MEASURED note: the
  // prior-weighted ensemble makes no money out of sample even when it "looks" scored).
  const validatedFactorCount = num(modelWeights, 'validated_factor_count');
  if (validatedFactorCount === 0) {
    return {
      headline: 'No factor has a validated edge.',
      summary: `None of the ${mix.total} signals have earned money on an earlier slice of history AND held up on a later slice they were never measured from. Today's ranking is descriptive, not predictive -- treat it as a shortlist to research, not a signal to trade.`,
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
