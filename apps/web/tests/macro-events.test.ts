import { describe, expect, it } from 'vitest';
import { type MacroEvent, parseMacroEvents, selectMacroBanner } from '../lib/macro-events';
import { NO_LEAKED_VALUES } from './noLeakedValues';

const NOW = new Date('2026-07-16T12:00:00.000Z');

function event(title: string, timeUtc: string | null): MacroEvent {
  return { title, timeUtc: timeUtc === null ? null : new Date(timeUtc) };
}

describe('parseMacroEvents', () => {
  it('parses well-formed entries out of market_context.macro_events', () => {
    const marketContext = {
      macro_events: [
        { title: 'CPI m/m', country: 'USD', impact: 'High', time_utc: '2026-07-17T12:30:00.000Z' },
      ],
    };

    const events = parseMacroEvents(marketContext);

    expect(events).toEqual([event('CPI m/m', '2026-07-17T12:30:00.000Z')]);
  });

  it('keeps an event with time_utc: null (an All Day / Tentative entry)', () => {
    const marketContext = { macro_events: [{ title: 'Bank Holiday', time_utc: null }] };

    expect(parseMacroEvents(marketContext)).toEqual([event('Bank Holiday', null)]);
  });

  it('drops an entry missing a title, silently', () => {
    const marketContext = {
      macro_events: [
        { time_utc: '2026-07-17T12:30:00.000Z' },
        { title: 'CPI m/m', time_utc: '2026-07-17T12:30:00.000Z' },
      ],
    };

    expect(parseMacroEvents(marketContext)).toEqual([event('CPI m/m', '2026-07-17T12:30:00.000Z')]);
  });

  it('treats an unparseable time_utc string as null rather than throwing', () => {
    const marketContext = { macro_events: [{ title: 'CPI m/m', time_utc: 'not-a-date' }] };

    expect(parseMacroEvents(marketContext)).toEqual([event('CPI m/m', null)]);
  });

  it('returns an empty array when market_context is absent or malformed', () => {
    expect(parseMacroEvents(undefined)).toEqual([]);
    expect(parseMacroEvents(null)).toEqual([]);
    expect(parseMacroEvents('not-an-object')).toEqual([]);
    expect(parseMacroEvents({})).toEqual([]);
  });

  it('returns an empty array when macro_events itself is missing or the wrong type', () => {
    expect(parseMacroEvents({ macro_events: 'not-an-array' })).toEqual([]);
    expect(parseMacroEvents({ macro_events: null })).toEqual([]);
    expect(parseMacroEvents({ other_field: 1 })).toEqual([]);
  });
});

describe('selectMacroBanner: upcoming window (now, now+36h]', () => {
  it('picks the soonest qualifying event, formatted as weekday + Jakarta local time + WIB', () => {
    const events = [
      event('CPI y/y', '2026-07-18T00:00:00.000Z'),
      event('CPI m/m', '2026-07-17T12:30:00.000Z'),
    ];

    const banner = selectMacroBanner(events, NOW);

    expect(banner.upcoming).toBe('High-impact US data ahead: CPI m/m — Fri 19:30 WIB.');
  });

  it('includes an event exactly at the now+36h boundary (inclusive)', () => {
    const events = [event('CPI y/y', '2026-07-18T00:00:00.000Z')];

    expect(selectMacroBanner(events, NOW).upcoming).not.toBeNull();
  });

  it('excludes an event one second past the now+36h boundary', () => {
    const events = [event('CPI y/y', '2026-07-18T00:00:01.000Z')];

    expect(selectMacroBanner(events, NOW).upcoming).toBeNull();
  });

  it('excludes an event exactly at now (the window is exclusive of now)', () => {
    const events = [event('CPI m/m', NOW.toISOString())];

    expect(selectMacroBanner(events, NOW).upcoming).toBeNull();
  });

  it('ignores an event with a null time_utc entirely', () => {
    const events = [event('Bank Holiday', null)];

    expect(selectMacroBanner(events, NOW).upcoming).toBeNull();
  });

  it('is null when nothing qualifies', () => {
    expect(selectMacroBanner([], NOW).upcoming).toBeNull();
  });
});

describe('selectMacroBanner: recent window [now-10h, now]', () => {
  it('picks the latest qualifying event and renders whole hours elapsed', () => {
    const events = [
      event('CPI m/m', '2026-07-16T02:00:00.000Z'),
      event('CPI y/y', '2026-07-16T09:00:00.000Z'),
    ];

    const banner = selectMacroBanner(events, NOW);

    expect(banner.recent).toBe('CPI y/y printed 3h ago — check that open setups survived it.');
  });

  it('includes an event exactly at the now-10h boundary (inclusive)', () => {
    const events = [event('CPI m/m', '2026-07-16T02:00:00.000Z')];

    expect(selectMacroBanner(events, NOW).recent).toBe(
      'CPI m/m printed 10h ago — check that open setups survived it.',
    );
  });

  it('excludes an event one second before the now-10h boundary', () => {
    const events = [event('CPI m/m', '2026-07-16T01:59:59.000Z')];

    expect(selectMacroBanner(events, NOW).recent).toBeNull();
  });

  it('includes an event exactly at now, rendered as "under an hour ago"', () => {
    const events = [event('CPI m/m', NOW.toISOString())];

    expect(selectMacroBanner(events, NOW).recent).toBe(
      'CPI m/m printed under an hour ago — check that open setups survived it.',
    );
  });

  it('renders less than a full hour elapsed as "under an hour ago", not "0h ago"', () => {
    const events = [event('CPI m/m', '2026-07-16T11:30:00.000Z')];

    expect(selectMacroBanner(events, NOW).recent).toBe(
      'CPI m/m printed under an hour ago — check that open setups survived it.',
    );
  });

  it('excludes a future event', () => {
    const events = [event('CPI m/m', '2026-07-16T12:00:01.000Z')];

    expect(selectMacroBanner(events, NOW).recent).toBeNull();
  });

  it('is null when nothing qualifies', () => {
    expect(selectMacroBanner([], NOW).recent).toBeNull();
  });
});

describe('selectMacroBanner: both lines together', () => {
  it('returns both an upcoming and a recent line simultaneously when both windows have a hit', () => {
    const events = [
      event('CPI y/y', '2026-07-16T09:00:00.000Z'),
      event('FOMC Statement', '2026-07-17T18:00:00.000Z'),
    ];

    const banner = selectMacroBanner(events, NOW);

    expect(banner.upcoming).not.toBeNull();
    expect(banner.recent).not.toBeNull();
  });

  it('returns { upcoming: null, recent: null } for an empty/malformed market_context end to end', () => {
    const banner = selectMacroBanner(parseMacroEvents(undefined), NOW);

    expect(banner).toEqual({ upcoming: null, recent: null });
  });

  it('never leaks null/NaN/undefined into either rendered line', () => {
    const events = [
      event('CPI y/y', '2026-07-16T09:00:00.000Z'),
      event('FOMC Statement', '2026-07-17T18:00:00.000Z'),
    ];

    const banner = selectMacroBanner(events, NOW);
    const joined = `${banner.upcoming}\n${banner.recent}`;

    expect(joined).not.toMatch(NO_LEAKED_VALUES);
  });
});
