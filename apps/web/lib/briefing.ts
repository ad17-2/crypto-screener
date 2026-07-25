import { capNarrative } from './text';
import { asRecord } from './wire';

/**
 * market_context.briefing is a free-form blob (no contracts schema -- see apps/api's
 * pipeline/briefing.ts) written by one DeepSeek call per refresh. Display-only: absent whenever
 * DEEPSEEK_API_KEY isn't set or the call failed, so every field here is read defensively.
 */

export interface ParsedBriefing {
  text: string;
  model: string;
  generatedAt: string | null;
  /** true/false only when the API explicitly said so; null covers absent (pre-dates this field)
   * and malformed alike -- both must read as "unknown", never as "false". */
  usedTools: boolean | null;
  toolCalls: number | null;
  /** Internal diagnostic (e.g. "exhausted 3 tool iterations"), parsed but never rendered --
   * may contain raw API error text. */
  toolError: string | null;
}

/** null for an absent/malformed blob or a non-string/blank `text`; `text` is trimmed and capped. */
export function parseBriefing(marketContext: unknown): ParsedBriefing | null {
  const briefing = asRecord(asRecord(marketContext).briefing);
  const rawText = briefing.text;
  if (typeof rawText !== 'string') return null;

  const text = rawText.trim();
  if (text.length === 0) return null;

  const model = typeof briefing.model === 'string' ? briefing.model : 'unknown';
  const generatedAt = typeof briefing.generated_at === 'string' ? briefing.generated_at : null;
  const usedTools = typeof briefing.used_tools === 'boolean' ? briefing.used_tools : null;
  const toolCalls = typeof briefing.tool_calls === 'number' ? briefing.tool_calls : null;
  const toolError = typeof briefing.tool_error === 'string' ? briefing.tool_error : null;

  return {
    text: capNarrative(text),
    model,
    generatedAt,
    usedTools,
    toolCalls,
    toolError,
  };
}

/**
 * Whether the "written without data lookups" provenance note should render. Only an explicit
 * `used_tools: false` qualifies -- absent (older runs pre-dating this field) or `true` must stay
 * silent, matching this repo's absent-unless-notable convention (size_multiplier chip, the removed
 * `holding` run-trend badge).
 */
export function briefingWrittenWithoutTools(briefing: ParsedBriefing): boolean {
  return briefing.usedTools === false;
}
