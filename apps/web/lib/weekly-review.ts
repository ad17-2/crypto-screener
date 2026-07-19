import type { WeeklyReview } from '@crypto-screener/contracts';
import { arr, num, str } from './payload';
import { capNarrative } from './text';

/**
 * payload.weekly_review is already zod-typed end to end (packages/contracts/src/dashboard.ts), so
 * unlike lib/briefing.ts's market_context.briefing (a free-form blob) there's no top-level shape to
 * defend against. `metrics` is still an untyped computed object inside that typed wrapper though --
 * see apps/api's db/weeklyReview.ts's WeeklyReviewMetrics -- so digging into it stays defensive,
 * same num/str/arr accessors as lib/payload.ts.
 */

export interface WeeklyReviewFact {
  label: string;
  value: string;
}

export interface ParsedWeeklyReview {
  narrative: string | null;
  model: string | null;
  generatedAt: string;
  weekStart: string;
  weekEnd: string;
  facts: WeeklyReviewFact[];
}

function formatHitRate(fraction: number | null): string {
  return fraction === null ? '—' : `${Math.round(fraction * 100)}%`;
}

/** One compact fact per (side, horizon) entry in metrics.side_hit_rates -- skips any entry missing the fields it needs. */
function sideHitRateFacts(metrics: unknown): WeeklyReviewFact[] {
  const facts: WeeklyReviewFact[] = [];
  for (const entry of arr(metrics, 'side_hit_rates')) {
    const side = str(entry, 'side');
    const horizon = num(entry, 'horizon_hours');
    const n = num(entry, 'n_raw');
    if (side === null || horizon === null || n === null) continue;
    facts.push({
      label: `${side} ${horizon}h`,
      value: `${formatHitRate(num(entry, 'hit_rate_raw'))} (n=${n})`,
    });
  }
  return facts;
}

/** null only when weekly_review itself is absent (no computation has ever run). */
export function parseWeeklyReview(
  weeklyReview: WeeklyReview | null | undefined,
): ParsedWeeklyReview | null {
  if (!weeklyReview) return null;

  const trimmed = typeof weeklyReview.narrative === 'string' ? weeklyReview.narrative.trim() : '';
  const narrative = trimmed.length === 0 ? null : capNarrative(trimmed);

  const facts = sideHitRateFacts(weeklyReview.metrics);
  if (narrative === null && facts.length === 0) return null;

  return {
    narrative,
    model: typeof weeklyReview.model === 'string' ? weeklyReview.model : null,
    generatedAt: weeklyReview.generated_at,
    weekStart: weeklyReview.week_start,
    weekEnd: weeklyReview.week_end,
    facts,
  };
}
