import { arr, str } from './payload';

/**
 * Display-only banner copy for the ForexFactory macro calendar (apps/api's
 * collectMacroCalendarContext) -- market_context.macro_events is already filtered server-side to
 * USD + High impact and capped at 30, so this module only picks which one(s), if any, are close
 * enough to now to surface. No scoring/gating reads this; it's copy for a banner, nothing else.
 */

export interface MacroEvent {
  title: string;
  /** null when the feed's time isn't a wall-clock time ('All Day', 'Tentative', blank). */
  timeUtc: Date | null;
}

export interface MacroBanner {
  /** The soonest event landing in (now, now+36h], or null when nothing qualifies. */
  upcoming: string | null;
  /** The latest event that printed in [now-10h, now], or null when nothing qualifies. */
  recent: string | null;
}

const UPCOMING_WINDOW_MS = 36 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 10 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

const JAKARTA_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Jakarta',
  hourCycle: 'h23',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function formatJakartaTime(date: Date): string {
  const parts = JAKARTA_TIME_FORMATTER.formatToParts(date);
  const lookup = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${lookup('weekday')} ${lookup('hour')}:${lookup('minute')}`;
}

function parseTimeUtc(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Reads market_context.macro_events defensively; entries without a usable title are dropped. */
export function parseMacroEvents(marketContext: unknown): MacroEvent[] {
  const events: MacroEvent[] = [];
  for (const item of arr(marketContext, 'macro_events')) {
    const title = str(item, 'title');
    if (!title) {
      continue;
    }
    events.push({ title, timeUtc: parseTimeUtc(str(item, 'time_utc')) });
  }
  return events;
}

function upcomingBannerText(title: string, timeUtc: Date): string {
  return `High-impact US data ahead: ${title} — ${formatJakartaTime(timeUtc)} WIB.`;
}

function recentBannerText(title: string, hoursAgo: number): string {
  const agoPhrase = hoursAgo === 0 ? 'under an hour ago' : `${hoursAgo}h ago`;
  return `${title} printed ${agoPhrase} — check that open setups survived it.`;
}

/** Picks (at most) one upcoming and one recent banner line; both may be non-null at once. */
export function selectMacroBanner(events: MacroEvent[], now: Date): MacroBanner {
  const nowMs = now.getTime();

  let soonest: { title: string; timeMs: number } | null = null;
  let latest: { title: string; timeMs: number } | null = null;

  for (const event of events) {
    if (!event.timeUtc) {
      continue;
    }
    const timeMs = event.timeUtc.getTime();

    if (timeMs > nowMs && timeMs <= nowMs + UPCOMING_WINDOW_MS) {
      if (!soonest || timeMs < soonest.timeMs) {
        soonest = { title: event.title, timeMs };
      }
    }

    if (timeMs <= nowMs && timeMs >= nowMs - RECENT_WINDOW_MS) {
      if (!latest || timeMs > latest.timeMs) {
        latest = { title: event.title, timeMs };
      }
    }
  }

  return {
    upcoming: soonest ? upcomingBannerText(soonest.title, new Date(soonest.timeMs)) : null,
    recent: latest
      ? recentBannerText(latest.title, Math.floor((nowMs - latest.timeMs) / MS_PER_HOUR))
      : null,
  };
}
