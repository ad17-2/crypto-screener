import { describe, expect, it } from 'vitest';
import { parseBriefing } from '../lib/briefing';
import { NO_LEAKED_VALUES } from './noLeakedValues';

describe('parseBriefing', () => {
  it('parses a well-formed market_context.briefing blob', () => {
    const marketContext = {
      briefing: {
        text: 'Tonight the tape is quiet.',
        model: 'deepseek-v4-pro',
        generated_at: '2026-07-19T00:00:00+07:00',
      },
    };

    expect(parseBriefing(marketContext)).toEqual({
      text: 'Tonight the tape is quiet.',
      model: 'deepseek-v4-pro',
      generatedAt: '2026-07-19T00:00:00+07:00',
    });
  });

  it('trims the rendered text', () => {
    const marketContext = { briefing: { text: '  spaced out  ', model: 'deepseek-v4-pro' } };

    expect(parseBriefing(marketContext)?.text).toBe('spaced out');
  });

  it('caps text at 1800 chars, adding an ellipsis', () => {
    const longText = 'a'.repeat(2000);
    const marketContext = { briefing: { text: longText, model: 'deepseek-v4-pro' } };

    const parsed = parseBriefing(marketContext);

    expect(parsed?.text).toHaveLength(1801);
    expect(parsed?.text.endsWith('…')).toBe(true);
    expect(parsed?.text.slice(0, 1800)).toBe(longText.slice(0, 1800));
  });

  it('does not touch text at exactly 1800 chars', () => {
    const exactText = 'b'.repeat(1800);
    const marketContext = { briefing: { text: exactText, model: 'deepseek-v4-pro' } };

    expect(parseBriefing(marketContext)?.text).toBe(exactText);
  });

  it('returns null when market_context is absent or malformed', () => {
    expect(parseBriefing(undefined)).toBeNull();
    expect(parseBriefing(null)).toBeNull();
    expect(parseBriefing('not-an-object')).toBeNull();
    expect(parseBriefing({})).toBeNull();
  });

  it('returns null when briefing itself is missing or the wrong type', () => {
    expect(parseBriefing({ briefing: null })).toBeNull();
    expect(parseBriefing({ briefing: 'not-an-object' })).toBeNull();
  });

  it('returns null when text is absent, non-string, or blank after trimming', () => {
    expect(parseBriefing({ briefing: { model: 'deepseek-v4-pro' } })).toBeNull();
    expect(parseBriefing({ briefing: { text: 42, model: 'deepseek-v4-pro' } })).toBeNull();
    expect(parseBriefing({ briefing: { text: '   ', model: 'deepseek-v4-pro' } })).toBeNull();
  });

  it('falls back to generatedAt: null when generated_at is missing or non-string', () => {
    const marketContext = { briefing: { text: 'ok', model: 'deepseek-v4-pro', generated_at: 42 } };

    expect(parseBriefing(marketContext)?.generatedAt).toBeNull();
  });

  it('never leaks null/NaN/undefined into the parsed text or model', () => {
    const marketContext = {
      briefing: { text: 'Tonight the tape is quiet.', model: 'deepseek-v4-pro' },
    };
    const parsed = parseBriefing(marketContext);

    expect(`${parsed?.text}\n${parsed?.model}`).not.toMatch(NO_LEAKED_VALUES);
  });
});
