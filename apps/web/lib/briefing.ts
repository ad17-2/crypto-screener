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

export interface BriefingCandidate {
  symbol: string;
  side: 'long' | 'short';
  reason: string;
}

export type BriefingBlock =
  | { kind: 'prose'; text: string }
  | { kind: 'candidates'; items: BriefingCandidate[] };

// Ticker: 2-15 chars of [A-Z0-9]. Separator: a single space, then em dash "—", hyphen "-", or en
// dash "–" (whichever the model actually emits -- BRIEFING_SYSTEM_PROMPT asks for an em dash, but
// this stays lenient rather than downgrading a whole block to prose over model punctuation drift),
// then a single space. Reasoning is the rest of the line -- `.+` already guarantees it's non-empty.
const CANDIDATE_LINE_PATTERN = /^([A-Z0-9]{2,15}) (long|short) [-–—] (.+)$/;

/**
 * Splits raw "Tonight's read" text into typed display blocks: alternating prose paragraphs and
 * blocks of one-line-per-candidate rows (see BRIEFING_SYSTEM_PROMPT in apps/api/src/pipeline/
 * briefing.ts for the shape this is parsing). A block only becomes `candidates` when EVERY one of
 * its non-empty lines matches the candidate pattern -- one stray line falls the whole block back to
 * `prose` rather than silently dropping the bad line, since a partially-parsed candidates block
 * would misrepresent what the model actually wrote.
 *
 * Backward compatibility: every briefing already stored in the DB (pre this shape) is a single
 * unbroken paragraph with zero blank lines, so it never contains the `\n\s*\n` separator this
 * parser splits on -- it always falls out as exactly one `prose` block, text unchanged. This is
 * called from MarketStage.tsx as `briefingBlocks(briefing.text)`, i.e. AFTER parseBriefing's
 * `capNarrative` cap, not folded into parseBriefing itself. That's safe because capNarrative
 * (lib/text.ts) is a plain `text.slice(0, max)` -- a character-index slice that never inspects or
 * strips `\n`, so it can neither destroy a legacy paragraph's shape nor collapse a new-format
 * briefing's blank-line block separators (short of truncating mid-block on a briefing far longer
 * than the ~6-sentence target this format asks for, which is an existing capNarrative truncation
 * concern, not one this parser introduces). Since capNarrative is newline-safe, splitting after it
 * is the less invasive choice -- no need to move the parse earlier or touch capNarrative itself.
 */
export function briefingBlocks(text: string): BriefingBlock[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks: BriefingBlock[] = [];

  for (const rawBlock of normalized.split(/\n\s*\n+/)) {
    const trimmedBlock = rawBlock.trim();
    if (trimmedBlock.length === 0) continue;

    const lines = trimmedBlock
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) continue;

    const items: BriefingCandidate[] = [];
    let allMatch = true;
    for (const line of lines) {
      const match = CANDIDATE_LINE_PATTERN.exec(line);
      const [, symbol, side, reason] = match ?? [];
      if (symbol && reason && (side === 'long' || side === 'short')) {
        items.push({ symbol, side, reason });
      } else {
        allMatch = false;
        break;
      }
    }

    blocks.push(
      allMatch ? { kind: 'candidates', items } : { kind: 'prose', text: lines.join(' ') },
    );
  }

  return blocks;
}
