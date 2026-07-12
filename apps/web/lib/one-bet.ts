import { arr, num, str } from './payload';

/**
 * Layer 3: THE ONE BET. Pure derivation over `model_weights` (`unknown`-typed on the wire, same
 * defensive-read convention as lib/model-health.ts) -- no React here.
 *
 * MEASURED (see the redesign brief this module was built from): the 12-factor prior-weighted
 * ensemble is forward-validated at net -0.007%/trade -- reversal_3d is the only one of the 12
 * factors that forward-validates. This module is deliberately locked to that one factor name,
 * not "whichever factor happens to be validated" -- a different factor clearing the money bar
 * later is a decision for a future redesign, not something this section should silently absorb.
 */
export const ONE_BET_FACTOR = 'reversal_3d';

export interface OneBetEvidence {
  /** true only when this factor's own edge_verdict is 'validated' -- earned money on an earlier
   *  slice of history AND still made money on a later slice it wasn't measured from. */
  validated: boolean;
  edgeVerdict: string | null;
  netSpreadPct: number | null;
  netEdgePer30dPct: number | null;
  edgeTStat: number | null;
  trainNetSpreadPct: number | null;
  validationNetSpreadPct: number | null;
}

/** null when reversal_3d isn't present in model_weights.factors at all (e.g. an empty payload). */
export function oneBetEvidence(modelWeights: unknown): OneBetEvidence | null {
  const factors = arr(modelWeights, 'factors');
  const entry = factors.find((factor) => str(factor, 'name') === ONE_BET_FACTOR);
  if (entry === undefined) return null;
  const edgeVerdict = str(entry, 'edge_verdict');
  return {
    validated: edgeVerdict === 'validated',
    edgeVerdict,
    netSpreadPct: num(entry, 'net_spread_pct'),
    netEdgePer30dPct: num(entry, 'net_edge_per_30d_pct'),
    edgeTStat: num(entry, 'edge_t_stat'),
    trainNetSpreadPct: num(entry, 'edge_train_net_spread_pct'),
    validationNetSpreadPct: num(entry, 'edge_validation_net_spread_pct'),
  };
}
