import { toFloat } from './scoring.js';
import type { CostsConfigInput, Row } from './types.js';

/**
 * Round-trip cost in pct-of-notional (0.05 = 0.05%): fees + slippage on both fills + one spread
 * crossing + funding accrued over the forward-return horizon.
 *
 * spread_bps is never populated by any live provider (see factors.ts); assumed_spread_bps stands in.
 *
 * funding_rate_pct: positive means longs pay shorts, charged/credited by directionalScore's side;
 * at directionalScore === 0 the unsigned magnitude is charged as a conservative fallback.
 */
export function roundTripCostPct(
  row: Row,
  costs: CostsConfigInput,
  forwardReturnHours: number,
  directionalScore: number,
): number {
  const takerFeeBps = costs.taker_fee_bps ?? 5;
  const slippageBps = costs.slippage_bps ?? 2;
  const assumedSpreadBps = costs.assumed_spread_bps ?? 2;
  const settlementsPerDay = costs.funding_settlements_per_day ?? 3;

  const tradingCostPct = (2 * (takerFeeBps + slippageBps)) / 100;
  const spreadBps = toFloat(row.spread_bps) ?? assumedSpreadBps;
  const spreadCostPct = spreadBps / 100;

  const fundingRate = toFloat(row.funding_rate_pct);
  let fundingCostPct = 0;
  if (fundingRate !== null) {
    const settlementsOverHorizon = settlementsPerDay * (forwardReturnHours / 24);
    const side = directionalScore > 0 ? 1 : directionalScore < 0 ? -1 : null;
    fundingCostPct =
      side === null
        ? Math.abs(fundingRate) * settlementsOverHorizon
        : side * fundingRate * settlementsOverHorizon;
  }

  return tradingCostPct + spreadCostPct + fundingCostPct;
}
