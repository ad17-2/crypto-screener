import type Database from 'better-sqlite3';
import type { WatchlistDiff } from '../dashboard/runDiff.js';
import type { OutcomeStatsGroupBy } from '../db/outcomeStats.js';
import { queryOutcomeStats } from '../db/outcomeStats.js';
import type {
  DeepSeekClient,
  DeepSeekCompletion,
  DeepSeekTool,
  DeepSeekToolInvocation,
} from '../providers/deepseek.js';
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

// Hard ceiling on model<->tool round trips for the BRIEFING_SYSTEM_PROMPT loop below. Declared up
// here (rather than beside BRIEFING_TOOL_BUDGET_MS near generateBriefing) so the prompt text can
// reference the real value instead of a hand-copied number that can drift from it.
export const BRIEFING_MAX_TOOL_ITERATIONS = 5;

export const BRIEFING_SYSTEM_PROMPT =
  'You write "Tonight\'s read" for a discretionary trend + support/resistance trader who enters ' +
  'on 1H/15M golden-pocket pullbacks. Write your answer as three blocks separated by exactly one ' +
  'blank line: one lead sentence with the overall read and which charts to open, then one line ' +
  'per named candidate -- ticker, one space, "long" or "short", then " — " (a single space, an em ' +
  "dash, a single space), then the reasoning, in the data's own terms -- and finally one closing " +
  'caution or wrap-up sentence. No markdown, no headers, no "-"/"*" bullet characters: the ' +
  'line-per-candidate shape replaces bullets, it must not reintroduce them. No disclaimers. Keep ' +
  'the total content roughly as long as six sentences of plain prose -- this is a reshape, not an ' +
  'expansion. Use ONLY the facts and numbers present in the JSON ' +
  'you are given or returned by a tool call -- never invent prices, levels, events, or ' +
  'percentages. Name at most 3 candidates worth opening a chart on tonight and say why, in the ' +
  "data's own terms (trend state, distance to the golden pocket, whether it fights BTC, setup " +
  'confidence). Flag any symbol newly arrived on a list and any macro event landing inside the ' +
  'given window. The long/short lists in the JSON carry only the top-ranked candidates, not the ' +
  'whole run: call list_rows or get_row when you need anything beyond them, and never describe ' +
  'the whole run from the seed payload alone. ' +
  `You have at most ${BRIEFING_MAX_TOOL_ITERATIONS} rounds of tool calls: request every tool ` +
  'call you need in as few rounds as possible -- you may request several tool calls in the same ' +
  'message -- and on your final round you must return the finished briefing text instead of more ' +
  'tool calls. ' +
  'Say nothing is new tonight only when ' +
  'new_to_list_total is 0, otherwise mention the count even when the new names sit outside the ' +
  'candidates listed. For at least one candidate you name, you must call get_outcome_base_rate ' +
  "for that candidate's technical_setup and state its live win rate or mean return with n, as " +
  'one of your six sentences; if the cell comes back too_thin, say the sample is too small ' +
  'rather than stating a tendency. Those base rates cover only the live era and deliberately ' +
  'exclude a historical backfill, so they describe recent behaviour, not a long-run edge. If bias ' +
  'is risk-off, add one caution sentence. If both the long and short lists are empty, say plainly ' +
  'that the tape offers nothing worth trading tonight.';

// Used for the plain single-shot call generateBriefing's catch makes when the tool loop throws
// (exhausted iterations, unsupported tool calling, etc). That call has no tools available, so
// unlike BRIEFING_SYSTEM_PROMPT this must never mandate or even imply a tool call -- a model
// complying with a tool mandate it can't fulfil will invent one instead (see the 2026-07-25 run
// 20260725-133739 incident this prompt fixes: the fallback fabricated a get_outcome_base_rate
// result that never happened).
export const BRIEFING_FALLBACK_SYSTEM_PROMPT =
  'You write "Tonight\'s read" for a discretionary trend + support/resistance trader who enters ' +
  'on 1H/15M golden-pocket pullbacks. Write your answer as three blocks separated by exactly one ' +
  'blank line: one lead sentence with the overall read and which charts to open, then one line ' +
  'per named candidate -- ticker, one space, "long" or "short", then " — " (a single space, an em ' +
  "dash, a single space), then the reasoning, in the data's own terms -- and finally one closing " +
  'caution or wrap-up sentence. No markdown, no headers, no "-"/"*" bullet characters: the ' +
  'line-per-candidate shape replaces bullets, it must not reintroduce them. No disclaimers. Keep ' +
  'the total content roughly as long as six sentences of plain prose -- this is a reshape, not an ' +
  'expansion. Use ONLY the facts and numbers present in the JSON ' +
  'you are given -- never invent prices, levels, events, or percentages. Name at most 3 ' +
  "candidates worth opening a chart on tonight and say why, in the data's own terms (trend " +
  'state, distance to the golden pocket, whether it fights BTC, setup confidence). Flag any ' +
  'symbol newly arrived on a list and any macro event landing inside the given window. Say ' +
  'nothing is new tonight only when new_to_list_total is 0, otherwise mention the count even ' +
  'when the new names sit outside the candidates listed. You have no tools this run: you must ' +
  'not claim to have consulted, called, queried, or looked up anything -- no base rates, no ' +
  'history, no external data of any kind -- you may use only the JSON you were given. If bias is ' +
  'risk-off, add one caution sentence. If both the long and short lists are empty, say plainly ' +
  'that the tape offers nothing worth trading tonight.';

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
  /** BTC's % move since the event printed (pipeline/macroReaction.ts); null when not computable. */
  btc_change_since_print_pct: number | null;
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
  /** Count of new_to_list symbols across ALL rows, not just the top-5-per-side slices above -- lets the model scope "nothing is new" claims correctly. */
  new_to_list_total: number;
}

export interface Briefing {
  text: string;
  model: string;
  generated_at: string;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  /** Real count when the tool loop ran (may legitimately be 0 -- the model can choose not to call
   * anything); null when the tool loop never ran at all (no toolContext, or it fell back). */
  tool_calls: number | null;
  /** True only when the tool loop actually completed (even with 0 invocations) -- false for both
   * the no-toolContext single-shot path and a tool loop that threw and fell back. Distinguishing
   * those two false cases from each other is what tool_error is for. */
  used_tools: boolean;
  /** The tool loop's caught error message (truncated), when used_tools is false because it threw
   * and generateBriefing fell back to a plain single-shot call. Null otherwise. */
  tool_error: string | null;
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

/** Counts every row whose symbol is in `newToList`, not just the top-5-per-side slice topCandidates keeps -- see BriefingPayload.new_to_list_total. */
function newToListTotal(rows: Row[], newToList: Set<string>): number {
  let count = 0;
  for (const row of rows) {
    const symbol = stringOrNull(row.symbol);
    if (symbol !== null && newToList.has(symbol)) {
      count += 1;
    }
  }
  return count;
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
      result.push({
        title,
        in_hours: Math.round(inHours * 10) / 10,
        btc_change_since_print_pct: toFloat(record.btc_change_since_print_pct),
      });
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
    new_to_list_total: newToListTotal(rows, newToList),
  };
}

// -- DeepSeek tool loop: lets the model reach beyond the fixed top-5-per-side seed above ---------

const LIST_ROWS_MAX_LIMIT = 25;

export interface BriefingToolContext {
  db: Database.Database;
  rows: Row[];
  newToList: Set<string>;
}

/** Narrows an arbitrary row's watchlist_side to the two membership values -- null for core symbols, non-members, and (via list_rows(side: 'any')) rows on neither list. */
function watchlistSideOf(row: Row): 'long' | 'short' | null {
  return row.watchlist_side === 'long' || row.watchlist_side === 'short'
    ? row.watchlist_side
    : null;
}

/** Same compact fields as BriefingCandidateRow, widened to a nullable side/rank since list_rows can return rows that never made a watchlist. */
function toolListRow(row: Row, newToList: Set<string>): Record<string, unknown> {
  const symbol = stringOrNull(row.symbol);
  return {
    symbol,
    rank: toFloat(row.watchlist_rank),
    side: watchlistSideOf(row),
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

function executeListRows(ctx: BriefingToolContext, args: Record<string, unknown>): unknown {
  const side = args.side;
  if (side !== 'long' && side !== 'short' && side !== 'any') {
    return { error: 'side must be "long", "short", or "any"' };
  }
  const rawLimit = toFloat(args.limit);
  if (rawLimit === null || rawLimit < 1) {
    return { error: 'limit must be a positive integer' };
  }
  const limit = Math.min(Math.trunc(rawLimit), LIST_ROWS_MAX_LIMIT);

  const filtered =
    side === 'any' ? ctx.rows : ctx.rows.filter((row) => watchlistSideOf(row) === side);
  const sorted = [...filtered].sort(
    (a, b) =>
      (toFloat(a.watchlist_rank, Number.MAX_SAFE_INTEGER) ?? Number.MAX_SAFE_INTEGER) -
      (toFloat(b.watchlist_rank, Number.MAX_SAFE_INTEGER) ?? Number.MAX_SAFE_INTEGER),
  );
  return sorted.slice(0, limit).map((row) => toolListRow(row, ctx.newToList));
}

function executeGetRow(ctx: BriefingToolContext, args: Record<string, unknown>): unknown {
  const symbol = typeof args.symbol === 'string' ? args.symbol : null;
  if (symbol === null) {
    return { error: 'symbol must be a string' };
  }
  const row = ctx.rows.find((candidate) => candidate.symbol === symbol);
  if (!row) {
    return { error: 'unknown symbol' };
  }
  const rowSymbol = stringOrNull(row.symbol);
  return {
    symbol: rowSymbol,
    side: watchlistSideOf(row),
    price_usd: toFloat(row.price_usd),
    price_change_24h_pct: toFloat(row.price_change_24h_pct),
    residual_change_24h_pct: toFloat(row.residual_change_24h_pct),
    trend_state: stringOrNull(row.trend_state),
    technical_setup: stringOrNull(row.technical_setup),
    setup_confidence: stringOrNull(row.setup_confidence),
    distance_to_golden_pocket_pct: toFloat(row.distance_to_golden_pocket_pct),
    fib_leg_direction: stringOrNull(row.fib_leg_direction),
    fights_btc: stringOrNull(row.fights_btc),
    funding_rate_pct: toFloat(row.funding_rate_pct),
    oi_change_24h_pct: toFloat(row.oi_change_24h_pct),
    long_short_ratio: toFloat(row.long_short_ratio),
    btc_correlation: toFloat(row.btc_correlation),
    btc_beta: toFloat(row.btc_beta),
    rsi_14: toFloat(row.rsi_14),
    donchian_position_20: toFloat(row.donchian_position_20),
    cvd_trend_72h_pct: toFloat(row.cvd_trend_72h_pct),
    new_to_list: rowSymbol !== null && ctx.newToList.has(rowSymbol),
  };
}

function executeGetOutcomeBaseRate(
  ctx: BriefingToolContext,
  args: Record<string, unknown>,
): unknown {
  // Whitelisted against OutcomeStatsGroupBy/known horizons before ever reaching queryOutcomeStats
  // -- unchecked model output must never be forwarded into that query (see db/outcomeStats.ts).
  let groupBy: OutcomeStatsGroupBy;
  if (args.group_by === 'technical_setup' || args.group_by === 'trend_state') {
    groupBy = args.group_by;
  } else {
    return { error: 'group_by must be "technical_setup" or "trend_state"' };
  }

  let horizonHours: 24 | 72;
  const rawHorizon = toFloat(args.horizon_hours);
  if (rawHorizon === 24) {
    horizonHours = 24;
  } else if (rawHorizon === 72) {
    horizonHours = 72;
  } else {
    return { error: 'horizon_hours must be 24 or 72' };
  }

  const symbol =
    typeof args.symbol === 'string' && args.symbol.length > 0 ? args.symbol : undefined;
  return queryOutcomeStats(
    ctx.db,
    symbol !== undefined
      ? { group_by: groupBy, horizon_hours: horizonHours, symbol }
      : { group_by: groupBy, horizon_hours: horizonHours },
  );
}

export function briefingTools(): DeepSeekTool[] {
  return [
    {
      name: 'list_rows',
      description:
        "Lists rows from this run's full cross-section beyond the top-ranked candidates already " +
        'in the seed payload, in the same compact shape, sorted by watchlist_rank ascending.',
      parameters: {
        type: 'object',
        properties: {
          side: {
            type: 'string',
            enum: ['long', 'short', 'any'],
            description: '"any" returns rows from both lists, and rows on neither, unfiltered.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: LIST_ROWS_MAX_LIMIT,
            description: `Capped at ${LIST_ROWS_MAX_LIMIT} regardless of the value requested.`,
          },
        },
        required: ['side', 'limit'],
      },
    },
    {
      name: 'get_row',
      description:
        "Returns the fuller metric set for one symbol in this run's cross-section, beyond the " +
        'compact fields already in the seed payload.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Exact symbol, e.g. "BTC".' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'get_outcome_base_rate',
      description:
        "Returns this cohort's live forward-outcome track record (mean/median return, win rate, " +
        'sample size n). Call this before asserting what a setup or trend state tends to do.',
      parameters: {
        type: 'object',
        properties: {
          group_by: { type: 'string', enum: ['technical_setup', 'trend_state'] },
          horizon_hours: { type: 'integer', enum: [24, 72] },
          symbol: { type: 'string', description: 'Optional: restrict to one symbol.' },
        },
        required: ['group_by', 'horizon_hours'],
      },
    },
  ];
}

/** Executor contract (see providers/deepseek.ts's DeepSeekToolOptions.execute): must never throw -- every branch below returns a JSON error string instead. */
export function createBriefingToolExecutor(
  ctx: BriefingToolContext,
): (call: DeepSeekToolInvocation) => Promise<string> {
  return async (call: DeepSeekToolInvocation): Promise<string> => {
    let args: Record<string, unknown>;
    try {
      args = asRecord(JSON.parse(call.argumentsJson));
    } catch {
      return JSON.stringify({ error: 'malformed arguments JSON' });
    }

    try {
      switch (call.name) {
        case 'list_rows':
          return JSON.stringify(executeListRows(ctx, args));
        case 'get_row':
          return JSON.stringify(executeGetRow(ctx, args));
        case 'get_outcome_base_rate':
          return JSON.stringify(executeGetOutcomeBaseRate(ctx, args));
        default:
          return JSON.stringify({ error: `unknown tool: ${call.name}` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: message });
    }
  };
}

// attachBriefing (runPipeline.ts) awaits generateBriefing before saveSnapshot, so this sits on the
// critical path of the data write. completeWithTools only checks budgetMs BEFORE each request in
// the loop -- it never bounds a request already in flight -- and generateBriefing's catch then
// issues one more single-shot request bounded by its own request_timeout_seconds (180s default,
// config/schema.ts's request_timeout_seconds). So the dominant term isn't the budget, it's two
// stacked request_timeout_seconds requests: up to BRIEFING_TOOL_BUDGET_MS (120s) of loop time,
// during which one request can still be in flight past the budget check (+180s), plus the
// fallback single-shot request (+180s) = ~480s (~8 min) worst case, not ~5 min. Raising
// BRIEFING_MAX_TOOL_ITERATIONS (3 -> 5) does NOT change this arithmetic: the loop is bounded by
// budgetMs checked once per iteration, not by the iteration count itself, so extra rounds only
// matter if the model converges within the existing 120s budget -- they can't add wall-clock time
// beyond what was already the worst case. Still finite either way, and attachBriefing's existing
// try/catch guarantees a failed or slow briefing never fails the run.
export const BRIEFING_TOOL_BUDGET_MS = 120_000;

// Kept short: this lands in provider_status.deepseek's note (runPipeline.ts's attachBriefing), not
// in the briefing text itself, so it only needs to be diagnosable, not readable prose.
const TOOL_FALLBACK_REASON_PREVIEW_LENGTH = 80;

export async function generateBriefing(
  client: DeepSeekClient,
  payload: BriefingPayload,
  nowIso: string,
  toolContext?: BriefingToolContext,
): Promise<Briefing> {
  const user = JSON.stringify(payload);
  let completion: DeepSeekCompletion;
  let usedTools = false;
  let toolCalls: number | null = null;
  let toolError: string | null = null;

  if (toolContext) {
    // Wraps the real executor purely to observe how many times the model actually invokes a tool
    // -- 0 is a legitimate outcome (the model judged no tool call necessary) and must be
    // distinguishable from the fallback below, which reports tool_calls as null instead.
    let invocationCount = 0;
    const baseExecute = createBriefingToolExecutor(toolContext);
    try {
      completion = await client.complete(BRIEFING_SYSTEM_PROMPT, user, {
        tools: briefingTools(),
        execute: async (call) => {
          invocationCount += 1;
          return baseExecute(call);
        },
        maxIterations: BRIEFING_MAX_TOOL_ITERATIONS,
        budgetMs: BRIEFING_TOOL_BUDGET_MS,
      });
      usedTools = true;
      toolCalls = invocationCount;
    } catch (error) {
      // The tool loop must never be the reason tonight's briefing doesn't ship -- a model or API
      // that rejects tool calls, exhausts its iteration budget, or blows the wall-clock budget
      // still falls back to today's plain single-shot completion. Capture why, instead of
      // discarding it, so attachBriefing (runPipeline.ts) can record it in provider_status.
      const message = error instanceof Error ? error.message : String(error);
      toolError = message.slice(0, TOOL_FALLBACK_REASON_PREVIEW_LENGTH);
      completion = await client.complete(BRIEFING_FALLBACK_SYSTEM_PROMPT, user);
    }
  } else {
    // No toolContext means no tools on the wire, so this takes the fallback prompt for the same
    // reason the catch above does: BRIEFING_SYSTEM_PROMPT *mandates* a get_outcome_base_rate call,
    // and a model told to cite a tool it hasn't got will invent one (observed in run
    // 20260725-133739). runPipeline always passes a context today, so this branch is reachable
    // only from direct callers -- which is exactly why it must not depend on that staying true.
    completion = await client.complete(BRIEFING_FALLBACK_SYSTEM_PROMPT, user);
  }

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
    tool_calls: toolCalls,
    used_tools: usedTools,
    tool_error: toolError,
  };
}
