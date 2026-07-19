import type { WatchlistDiff } from '../dashboard/runDiff.js';
import type { DeepSeekClient } from '../providers/deepseek.js';
import { ProviderError } from '../providers/errors.js';
import { toFloat } from './scoring.js';
import type { MarketContext, Row } from './types.js';
import { asRecord } from './types.js';

/**
 * Builds the compact JSON payload sent to DeepSeek for the "Tonight's read" briefing, and wraps
 * the completion into the shape stored at market_context.briefing. Pure and display-only: nothing
 * here feeds scoring or watchlist membership (see runPipeline.ts for the wiring that calls this).
 */

const MAX_CANDIDATES_PER_LIST = 5;
// "next 48h or last 12h" -- precomputed here so the model never does its own time math.
const MACRO_LOOKAHEAD_HOURS = 48;
const MACRO_LOOKBACK_HOURS = 12;
const MS_PER_HOUR = 60 * 60 * 1000;

export const BRIEFING_SYSTEM_PROMPT =
  'You write "Tonight\'s read" for a discretionary trend + support/resistance trader who enters ' +
  'on 1H/15M golden-pocket pullbacks. Write at most 6 sentences of plain prose -- no markdown, no ' +
  'headers, no bullet points, no disclaimers. Use ONLY the facts and numbers present in the JSON ' +
  'you are given -- never invent prices, levels, events, or percentages. Name at most 3 candidates ' +
  "worth opening a chart on tonight and say why, in the data's own terms (trend state, distance to " +
  'the golden pocket, whether it fights BTC, setup confidence). Flag any symbol newly arrived on a ' +
  'list and any macro event landing inside the given window. If bias is risk-off, add one caution ' +
  'sentence. If both the long and short lists are empty, say plainly that the tape offers nothing ' +
  'worth trading tonight.';

export interface BriefingCandidateRow {
  symbol: string | null;
  rank: number | null;
  side: 'long' | 'short';
  price_usd: number | null;
  price_change_24h_pct: number | null;
  trend_state: string | null;
  setup_confidence: string | null;
  distance_to_golden_pocket_pct: number | null;
  fib_leg_direction: string | null;
  new_to_list: boolean;
  fights_btc: string | null;
}

export interface BriefingMacroEvent {
  title: string;
  /** Signed hours from now, rounded to 1dp -- negative means it already printed. */
  in_hours: number;
}

export interface BriefingWatchlistDepartures {
  baseline_run_id: string;
  departed_long: string[];
  departed_short: string[];
}

export interface BriefingPayload {
  long: BriefingCandidateRow[];
  short: BriefingCandidateRow[];
  watchlist_departures: BriefingWatchlistDepartures | null;
  regime: { state: string | null; bias: string | null };
  fear_greed: { value: number | null; classification: string | null };
  btc_change_24h_pct: number | null;
  macro_events: BriefingMacroEvent[];
}

export interface Briefing {
  text: string;
  model: string;
  generated_at: string;
  output_tokens: number | null;
  reasoning_tokens: number | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function candidateRow(
  row: Row,
  side: 'long' | 'short',
  newToList: Set<string>,
): BriefingCandidateRow {
  const symbol = stringOrNull(row.symbol);
  return {
    symbol,
    rank: toFloat(row.watchlist_rank),
    side,
    price_usd: toFloat(row.price_usd),
    price_change_24h_pct: toFloat(row.price_change_24h_pct),
    trend_state: stringOrNull(row.trend_state),
    setup_confidence: stringOrNull(row.setup_confidence),
    distance_to_golden_pocket_pct: toFloat(row.distance_to_golden_pocket_pct),
    fib_leg_direction: stringOrNull(row.fib_leg_direction),
    new_to_list: symbol !== null && newToList.has(symbol),
    fights_btc: stringOrNull(row.fights_btc),
  };
}

/** `row.watchlist_side`/`watchlist_rank` are stamped pre-save by dashboard/watchlists.ts's annotateWatchlistMembership. */
function topCandidates(
  rows: Row[],
  side: 'long' | 'short',
  newToList: Set<string>,
): BriefingCandidateRow[] {
  return rows
    .filter((row) => row.watchlist_side === side)
    .sort(
      (a, b) =>
        (toFloat(a.watchlist_rank, Number.MAX_SAFE_INTEGER) ?? Number.MAX_SAFE_INTEGER) -
        (toFloat(b.watchlist_rank, Number.MAX_SAFE_INTEGER) ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, MAX_CANDIDATES_PER_LIST)
    .map((row) => candidateRow(row, side, newToList));
}

/** Mirrors pipeline/regime.ts's own btcChange(): the BTC row's own 24h move, falling back to the market-context field backfill.ts writes. */
function btcChange24hPct(rows: Row[], marketContext: MarketContext): number | null {
  for (const row of rows) {
    if (row.symbol === 'BTC') {
      return toFloat(row.price_change_24h_pct);
    }
  }
  return toFloat(marketContext.btc_price_change_24h_pct);
}

/** market_context.macro_events is already filtered server-side to USD + High impact (see pipeline/collector.ts). */
function macroEventsInWindow(marketContext: MarketContext, nowMs: number): BriefingMacroEvent[] {
  const events = Array.isArray(marketContext.macro_events) ? marketContext.macro_events : [];
  const result: BriefingMacroEvent[] = [];
  for (const raw of events) {
    const record = asRecord(raw);
    const title = stringOrNull(record.title);
    const timeUtc = stringOrNull(record.time_utc);
    if (!title || !timeUtc) {
      continue;
    }
    const eventMs = Date.parse(timeUtc);
    if (Number.isNaN(eventMs)) {
      continue;
    }
    const inHours = (eventMs - nowMs) / MS_PER_HOUR;
    if (inHours >= -MACRO_LOOKBACK_HOURS && inHours <= MACRO_LOOKAHEAD_HOURS) {
      result.push({ title, in_hours: Math.round(inHours * 10) / 10 });
    }
  }
  return result;
}

export function buildBriefingPayload(
  rows: Row[],
  watchlists: WatchlistDiff,
  marketContext: MarketContext,
  regime: Record<string, unknown>,
  nowIso: string,
): BriefingPayload {
  const nowMs = Date.parse(nowIso);
  const newToList = watchlists.newToList;
  const changes = watchlists.changes;

  return {
    long: topCandidates(rows, 'long', newToList),
    short: topCandidates(rows, 'short', newToList),
    watchlist_departures: changes
      ? {
          baseline_run_id: changes.baseline_run_id,
          departed_long: changes.departed_long,
          departed_short: changes.departed_short,
        }
      : null,
    regime: {
      state: stringOrNull(regime.regime_state) ?? stringOrNull(regime.label),
      bias: stringOrNull(regime.bias),
    },
    fear_greed: {
      value: toFloat(marketContext.fear_greed_value),
      classification: stringOrNull(marketContext.fear_greed_classification),
    },
    btc_change_24h_pct: btcChange24hPct(rows, marketContext),
    macro_events: Number.isNaN(nowMs) ? [] : macroEventsInWindow(marketContext, nowMs),
  };
}

export async function generateBriefing(
  client: DeepSeekClient,
  payload: BriefingPayload,
  nowIso: string,
): Promise<Briefing> {
  const completion = await client.complete(BRIEFING_SYSTEM_PROMPT, JSON.stringify(payload));
  const text = completion.text.trim();
  if (text.length === 0) {
    throw new ProviderError('DeepSeek briefing completion was empty after trimming');
  }
  return {
    text,
    model: completion.model,
    generated_at: nowIso,
    output_tokens: completion.output_tokens,
    reasoning_tokens: completion.reasoning_tokens,
  };
}
