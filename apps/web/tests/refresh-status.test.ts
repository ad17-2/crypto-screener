import { describe, expect, it } from 'vitest';
import { parseRefreshStatus, refreshStatusChip } from '../lib/refresh-status';
import { NO_LEAKED_VALUES } from './noLeakedValues';

describe('parseRefreshStatus', () => {
  it('parses the idle state', () => {
    expect(parseRefreshStatus({ state: 'idle' })).toEqual({
      state: 'idle',
      error: null,
      startedAt: null,
      finishedAt: null,
    });
  });

  it('parses the running state, reading started_at', () => {
    expect(
      parseRefreshStatus({
        state: 'running',
        reason: 'scheduled',
        started_at: '2026-07-18T10:00:00+00:00',
      }),
    ).toEqual({
      state: 'running',
      error: null,
      startedAt: '2026-07-18T10:00:00+00:00',
      finishedAt: null,
    });
  });

  it('parses the ok state, reading finished_at', () => {
    expect(
      parseRefreshStatus({
        state: 'ok',
        reason: 'scheduled',
        run_id: 'run-1',
        generated_at: '2026-07-18T10:00:00+00:00',
        finished_at: '2026-07-18T10:05:00+00:00',
        duration_seconds: 300,
        paths: {},
        retention: null,
      }),
    ).toEqual({
      state: 'ok',
      error: null,
      startedAt: null,
      finishedAt: '2026-07-18T10:05:00+00:00',
    });
  });

  it('parses the error state, reading the error string', () => {
    expect(
      parseRefreshStatus({
        state: 'error',
        reason: 'scheduled',
        error: 'CoinGlass 429',
        finished_at: '2026-07-18T10:05:00+00:00',
      }),
    ).toEqual({
      state: 'error',
      error: 'CoinGlass 429',
      startedAt: null,
      finishedAt: '2026-07-18T10:05:00+00:00',
    });
  });

  it('parses the re-entrant quirk: state "running" with leftover "ok" fields spread in', () => {
    // apps/api/src/refresh/runtime.ts's re-entrancy guard can produce this shape -- reads must not
    // assume a field is absent just because `state` says it shouldn't be there.
    const result = parseRefreshStatus({
      state: 'running',
      reason: 'scheduled',
      started_at: '2026-07-18T10:00:00+00:00',
      run_id: 'run-0',
      generated_at: '2026-07-18T09:30:00+00:00',
      finished_at: '2026-07-18T09:35:00+00:00',
      duration_seconds: 300,
      paths: {},
      retention: null,
    });
    expect(result).toEqual({
      state: 'running',
      error: null,
      startedAt: '2026-07-18T10:00:00+00:00',
      finishedAt: '2026-07-18T09:35:00+00:00',
    });
  });

  it('returns null for null', () => {
    expect(parseRefreshStatus(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseRefreshStatus(undefined)).toBeNull();
  });

  it('returns null for a non-object value', () => {
    expect(parseRefreshStatus('running')).toBeNull();
  });

  it('returns null for an object missing state', () => {
    expect(parseRefreshStatus({ reason: 'scheduled' })).toBeNull();
  });

  it('returns null for an unrecognized state value', () => {
    expect(parseRefreshStatus({ state: 'nonsense' })).toBeNull();
  });

  it('returns null when state is not a string', () => {
    expect(parseRefreshStatus({ state: 42 })).toBeNull();
  });

  it('ignores non-string error/started_at/finished_at rather than leaking them', () => {
    const result = parseRefreshStatus({
      state: 'error',
      error: 500,
      started_at: null,
      finished_at: false,
    });
    expect(result).toEqual({
      state: 'error',
      error: null,
      startedAt: null,
      finishedAt: null,
    });
  });
});

describe('refreshStatusChip', () => {
  it('returns null for a null parsed status', () => {
    expect(refreshStatusChip(null)).toBeNull();
  });

  it('returns null for idle', () => {
    expect(refreshStatusChip(parseRefreshStatus({ state: 'idle' }))).toBeNull();
  });

  it('returns null for ok', () => {
    expect(
      refreshStatusChip(
        parseRefreshStatus({
          state: 'ok',
          reason: 'scheduled',
          run_id: 'run-1',
          generated_at: '2026-07-18T10:00:00+00:00',
          finished_at: '2026-07-18T10:05:00+00:00',
          duration_seconds: 300,
          paths: {},
          retention: null,
        }),
      ),
    ).toBeNull();
  });

  it('returns the warn chip for error, with the raw error string only in title', () => {
    const chip = refreshStatusChip(
      parseRefreshStatus({ state: 'error', reason: 'scheduled', error: 'CoinGlass 429' }),
    );
    expect(chip).toEqual({
      text: 'Refresh failing — retrying every 5 min',
      tone: 'warn',
      title: 'CoinGlass 429',
    });
    expect(chip?.text).not.toContain('CoinGlass 429');
  });

  it('returns the warn chip for error with a null title when no error string parsed', () => {
    const chip = refreshStatusChip(parseRefreshStatus({ state: 'error' }));
    expect(chip).toEqual({
      text: 'Refresh failing — retrying every 5 min',
      tone: 'warn',
      title: null,
    });
  });

  it('returns the muted chip for running', () => {
    const chip = refreshStatusChip(
      parseRefreshStatus({
        state: 'running',
        reason: 'scheduled',
        started_at: '2026-07-18T10:00:00+00:00',
      }),
    );
    expect(chip).toEqual({ text: 'Refresh in progress', tone: 'muted', title: null });
  });

  it('returns the muted chip for the re-entrant quirk (state "running" with leftover ok fields)', () => {
    const chip = refreshStatusChip(
      parseRefreshStatus({
        state: 'running',
        reason: 'scheduled',
        started_at: '2026-07-18T10:00:00+00:00',
        finished_at: '2026-07-18T09:35:00+00:00',
      }),
    );
    expect(chip).toEqual({ text: 'Refresh in progress', tone: 'muted', title: null });
  });

  it('never leaks a raw null/NaN/undefined value in chip text', () => {
    const cases = [
      { state: 'error' },
      { state: 'error', error: 'boom' },
      { state: 'running' },
      { state: 'idle' },
      null,
      'not-an-object',
      { state: 'nonsense' },
    ];
    for (const value of cases) {
      const chip = refreshStatusChip(parseRefreshStatus(value));
      if (chip !== null) {
        expect(chip.text).not.toMatch(NO_LEAKED_VALUES);
      }
    }
  });
});
