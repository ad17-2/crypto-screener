import { describe, expect, it } from 'vitest';
import { briefingBlocks, briefingWrittenWithoutTools, parseBriefing } from '../lib/briefing';
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
      usedTools: null,
      toolCalls: null,
      toolError: null,
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

  it('reads used_tools/tool_calls/tool_error when explicitly set', () => {
    const marketContext = {
      briefing: {
        text: 'ok',
        model: 'deepseek-v4-pro',
        used_tools: true,
        tool_calls: 3,
        tool_error: null,
      },
    };

    const parsed = parseBriefing(marketContext);
    expect(parsed?.usedTools).toBe(true);
    expect(parsed?.toolCalls).toBe(3);
    expect(parsed?.toolError).toBeNull();
  });

  it('reads used_tools: false and a tool_error string', () => {
    const marketContext = {
      briefing: {
        text: 'ok',
        model: 'deepseek-v4-pro',
        used_tools: false,
        tool_calls: null,
        tool_error: 'exhausted 3 tool iterations',
      },
    };

    const parsed = parseBriefing(marketContext);
    expect(parsed?.usedTools).toBe(false);
    expect(parsed?.toolCalls).toBeNull();
    expect(parsed?.toolError).toBe('exhausted 3 tool iterations');
  });

  it('falls back to usedTools/toolCalls/toolError: null when the fields are absent entirely', () => {
    const marketContext = { briefing: { text: 'ok', model: 'deepseek-v4-pro' } };

    const parsed = parseBriefing(marketContext);
    expect(parsed?.usedTools).toBeNull();
    expect(parsed?.toolCalls).toBeNull();
    expect(parsed?.toolError).toBeNull();
  });

  it('falls back to usedTools/toolCalls/toolError: null on malformed, non-boolean/number/string values', () => {
    const marketContext = {
      briefing: {
        text: 'ok',
        model: 'deepseek-v4-pro',
        used_tools: 'yes',
        tool_calls: '3',
        tool_error: 42,
      },
    };

    const parsed = parseBriefing(marketContext);
    expect(parsed?.usedTools).toBeNull();
    expect(parsed?.toolCalls).toBeNull();
    expect(parsed?.toolError).toBeNull();
  });
});

describe('briefingWrittenWithoutTools', () => {
  it('shows the note only when usedTools is explicitly false', () => {
    const base = { text: 'ok', model: 'm', generatedAt: null, toolCalls: null, toolError: null };

    expect(briefingWrittenWithoutTools({ ...base, usedTools: false })).toBe(true);
  });

  it('stays silent when usedTools is true', () => {
    const base = { text: 'ok', model: 'm', generatedAt: null, toolCalls: null, toolError: null };

    expect(briefingWrittenWithoutTools({ ...base, usedTools: true })).toBe(false);
  });

  it('stays silent when usedTools is absent/unknown (null)', () => {
    const base = { text: 'ok', model: 'm', generatedAt: null, toolCalls: null, toolError: null };

    expect(briefingWrittenWithoutTools({ ...base, usedTools: null })).toBe(false);
  });
});

describe('briefingBlocks', () => {
  it('parses a new-format briefing into lead prose, a candidates block, and closing prose', () => {
    const text = [
      'The tape leans long tonight, open VANA and BNB for the clearest reactions.',
      '',
      'VANA long — reclaimed the 4h golden pocket with rising OI.',
      'BNB short — fights BTC into resistance, funding stretched.',
      'ETC short — breakdown confirmed below the range low.',
      '',
      'Keep size small given the risk-off tone across majors tonight.',
    ].join('\n');

    expect(briefingBlocks(text)).toEqual([
      {
        kind: 'prose',
        text: 'The tape leans long tonight, open VANA and BNB for the clearest reactions.',
      },
      {
        kind: 'candidates',
        items: [
          {
            symbol: 'VANA',
            side: 'long',
            reason: 'reclaimed the 4h golden pocket with rising OI.',
          },
          {
            symbol: 'BNB',
            side: 'short',
            reason: 'fights BTC into resistance, funding stretched.',
          },
          { symbol: 'ETC', side: 'short', reason: 'breakdown confirmed below the range low.' },
        ],
      },
      { kind: 'prose', text: 'Keep size small given the risk-off tone across majors tonight.' },
    ]);
  });

  it('never leaks a null/NaN/undefined value into a parsed candidate reason', () => {
    const text = 'VANA long — reclaimed the 4h golden pocket with rising OI.';
    const [block] = briefingBlocks(text);

    expect(block?.kind).toBe('candidates');
    if (block?.kind === 'candidates') {
      for (const item of block.items) {
        expect(item.reason).not.toMatch(NO_LEAKED_VALUES);
      }
    }
  });

  it('the legacy single-paragraph blob (no blank lines) parses as exactly one unchanged prose block', () => {
    // Load-bearing regression test: every briefing already in the DB predates this shape and is a
    // single unbroken paragraph like this one -- it must keep rendering exactly as it does today.
    const legacy =
      'BTC holds its range with funding flat and the fear/greed index sitting near neutral, ' +
      'ETH continues to lag the broader market on relative strength while open interest drifts ' +
      'sideways across majors, and no macro print lands inside the next 48 hours worth flagging, ' +
      'so tonight favors patience over forcing a new entry until price shows a clean reaction at ' +
      'a level worth defending.';

    expect(briefingBlocks(legacy)).toEqual([{ kind: 'prose', text: legacy }]);
  });

  it('falls the whole block back to prose when one candidate line does not match the pattern', () => {
    const text = [
      'VANA long — reclaimed the 4h golden pocket with rising OI.',
      'this line does not match the candidate pattern at all',
      'ETC short — breakdown confirmed below the range low.',
    ].join('\n');

    expect(briefingBlocks(text)).toEqual([
      {
        kind: 'prose',
        text:
          'VANA long — reclaimed the 4h golden pocket with rising OI. ' +
          'this line does not match the candidate pattern at all ' +
          'ETC short — breakdown confirmed below the range low.',
      },
    ]);
  });

  it('accepts em dash, hyphen, and en dash as the candidate-line separator', () => {
    const text = [
      'VANA long — em dash works.',
      'BNB short - hyphen works too.',
      'ETC long – en dash also works.',
    ].join('\n');

    expect(briefingBlocks(text)).toEqual([
      {
        kind: 'candidates',
        items: [
          { symbol: 'VANA', side: 'long', reason: 'em dash works.' },
          { symbol: 'BNB', side: 'short', reason: 'hyphen works too.' },
          { symbol: 'ETC', side: 'long', reason: 'en dash also works.' },
        ],
      },
    ]);
  });

  it('parses \\r\\n line endings identically to \\n', () => {
    const lines = [
      'Lead sentence about tonight.',
      '',
      'VANA long — reclaimed the golden pocket.',
      '',
      'Closing sentence.',
    ];

    expect(briefingBlocks(lines.join('\r\n'))).toEqual(briefingBlocks(lines.join('\n')));
  });

  it('returns an empty array for blank or empty input, without throwing', () => {
    expect(briefingBlocks('')).toEqual([]);
    expect(briefingBlocks('   \n\n  \n ')).toEqual([]);
  });

  it('capNarrative does not strip blank lines -- a new-format briefing still splits into multiple blocks after parseBriefing', () => {
    // Proves the backward-compat decision documented at briefingBlocks' definition: capNarrative
    // (a plain character-index slice) runs before this parser inside parseBriefing today, and must
    // not collapse or strip the blank lines a new-format briefing depends on.
    const newFormatText = [
      'Lead sentence about tonight.',
      '',
      'VANA long — reclaimed the golden pocket.',
      'BNB short — fights BTC into resistance.',
      '',
      'Closing caution sentence.',
    ].join('\n');
    const marketContext = { briefing: { text: newFormatText, model: 'deepseek-v4-pro' } };

    const parsed = parseBriefing(marketContext);

    expect(parsed?.text).toContain('\n\n');
    expect(parsed ? briefingBlocks(parsed.text).map((block) => block.kind) : []).toEqual([
      'prose',
      'candidates',
      'prose',
    ]);
  });
});
