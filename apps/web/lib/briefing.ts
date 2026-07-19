import { asRecord } from './wire';

/**
 * market_context.briefing is a free-form blob (no contracts schema -- see apps/api's
 * pipeline/briefing.ts) written by one DeepSeek call per refresh. Display-only: absent whenever
 * DEEPSEEK_API_KEY isn't set or the call failed, so every field here is read defensively.
 */

const MAX_RENDER_LENGTH = 1800;

export interface ParsedBriefing {
  text: string;
  model: string;
  generatedAt: string | null;
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

  return {
    text: text.length > MAX_RENDER_LENGTH ? `${text.slice(0, MAX_RENDER_LENGTH)}…` : text,
    model,
    generatedAt,
  };
}
