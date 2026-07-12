import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type MarketVerdictInput, marketVerdict, sieveStages } from '../lib/verdict';
import { NO_LEAKED_VALUES } from './noLeakedValues';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../api/tests/fixtures/dashboard-payload.json',
);

interface Fixture {
  run: unknown;
  regime: unknown;
  market_context: unknown;
  provider_status: unknown;
  validation: unknown;
  quality: unknown;
  watchlists: unknown;
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture;
}

function verdictInput(overrides: Partial<MarketVerdictInput> = {}): MarketVerdictInput {
  return {
    regime: {},
    market_context: {},
    validation: {},
    quality: {},
    ...overrides,
  };
}

function breadth(label: string) {
  return { market_context: { breadth: { label } } };
}

describe('marketVerdict headline: bias x breadth', () => {
  const cases: Array<[string, unknown, string]> = [
    [
      'chaos regime state short-circuits everything',
      { regime_state: 'chaos', bias: 'risk-on' },
      'Conditions are chaotic.',
    ],
    ['risk-off + broad-risk-off', { bias: 'risk-off' }, "Risk-off, and it's broad."],
    ['risk-off + selective-risk-off', { bias: 'risk-off' }, 'Risk-off, but selective.'],
    ['risk-off + mixed breadth', { bias: 'risk-off' }, 'Risk-off, but selective.'],
    ['risk-on + broad-risk-on', { bias: 'risk-on' }, "Risk-on, and it's broad."],
    ['risk-on + selective-risk-on', { bias: 'risk-on' }, 'Risk-on, but narrow.'],
    ['risk-on + mixed breadth', { bias: 'risk-on' }, 'Risk-on, but narrow.'],
    ['bias mixed', { bias: 'mixed' }, 'No clear direction.'],
  ];
  const breadthByCase: Record<string, string> = {
    'risk-off + broad-risk-off': 'broad-risk-off',
    'risk-off + selective-risk-off': 'selective-risk-off',
    'risk-off + mixed breadth': 'mixed',
    'risk-on + broad-risk-on': 'broad-risk-on',
    'risk-on + selective-risk-on': 'selective-risk-on',
    'risk-on + mixed breadth': 'mixed',
  };

  it.each(cases)('%s', (name, regime, expected) => {
    const breadthLabel = breadthByCase[name];
    const marketContext = breadthLabel ? breadth(breadthLabel).market_context : {};
    const result = marketVerdict(verdictInput({ regime, market_context: marketContext }));
    expect(result.headline).toBe(expected);
  });

  it('falls back to "Mixed conditions." when bias/breadth are missing entirely', () => {
    const result = marketVerdict(verdictInput());
    expect(result.headline).toBe('Mixed conditions.');
  });

  it('falls back to "Mixed conditions." when bias and breadth contradict each other', () => {
    const result = marketVerdict(
      verdictInput({
        regime: { bias: 'risk-off' },
        market_context: breadth('broad-risk-on').market_context,
      }),
    );
    expect(result.headline).toBe('Mixed conditions.');
  });
});

describe('marketVerdict summary: calibration_label', () => {
  it.each([
    ['learning', /still calibrating/],
    ['useful', /right more often than not/],
    ['neutral', /coin flip/],
    ['weak', /missed more than/],
  ])('phrases %s honestly', (calibrationLabel, expectedPattern) => {
    const result = marketVerdict(
      verdictInput({ validation: { calibration_label: calibrationLabel } }),
    );
    expect(result.summary).toMatch(expectedPattern);
  });

  it('has a safe default summary when calibration_label is missing', () => {
    const result = marketVerdict(verdictInput());
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).not.toMatch(NO_LEAKED_VALUES);
  });
});

describe('marketVerdict facts', () => {
  it('renders the advancers/sample_size fact when breadth data is present', () => {
    const result = marketVerdict(
      verdictInput({ market_context: { breadth: { advancers: 9, sample_size: 50 } } }),
    );
    expect(result.facts).toContain('9 of 50 coins are up over 24h.');
  });

  it('omits the advancers fact when breadth data is missing', () => {
    const result = marketVerdict(verdictInput());
    expect(result.facts.some((fact) => fact.includes('coins are up'))).toBe(false);
  });

  it('renders the sector fact when leaders/laggards are present', () => {
    const result = marketVerdict(
      verdictInput({
        market_context: {
          categories: {
            leaders: [{ name: 'DeFi', market_cap_change_24h_pct: 12.3456 }],
            laggards: [{ name: 'Memes', market_cap_change_24h_pct: -5.6789 }],
          },
        },
      }),
    );
    expect(result.facts).toContain('DeFi leads (+12.3%), Memes lags (-5.7%).');
  });

  it('falls back to "No sector is clearly leading." when categories are entirely absent', () => {
    const result = marketVerdict(verdictInput());
    expect(result.facts).toContain('No sector is clearly leading.');
  });

  it('renders the long/short skew fact from validation.watchlist_counts', () => {
    const result = marketVerdict(
      verdictInput({ validation: { watchlist_counts: { long: 12, short: 7 } } }),
    );
    expect(result.facts).toContain('12 long setups vs 7 short.');
  });

  it('renders the BTC + dominance fact when both values are present', () => {
    const result = marketVerdict(
      verdictInput({
        regime: { btc_change_24h_pct: -2.1069 },
        market_context: { btc_dominance_pct: 55.9735 },
      }),
    );
    expect(result.facts).toContain('BTC -2.1% · dominance 56.0%.');
  });

  it('omits the BTC fact when only one of the two values is present', () => {
    const result = marketVerdict(verdictInput({ regime: { btc_change_24h_pct: -2.1 } }));
    expect(result.facts.some((fact) => fact.startsWith('BTC '))).toBe(false);
  });

  it('never renders null/NaN/undefined for a fully empty payload', () => {
    const result = marketVerdict(verdictInput());
    const joined = `${result.headline}\n${result.summary}\n${result.facts.join('\n')}`;
    expect(joined).not.toMatch(NO_LEAKED_VALUES);
  });

  it('never renders null/NaN/undefined when fields are present but wrongly typed', () => {
    const malformed = verdictInput({
      regime: { bias: 42, btc_change_24h_pct: 'not-a-number' },
      market_context: { breadth: 'not-an-object', btc_dominance_pct: null },
      validation: { calibration_label: null, watchlist_counts: 'nope' },
    });
    const result = marketVerdict(malformed);
    const joined = `${result.headline}\n${result.summary}\n${result.facts.join('\n')}`;
    expect(joined).not.toMatch(NO_LEAKED_VALUES);
  });
});

describe('marketVerdict against the real frozen fixture', () => {
  const fixture = loadFixture();

  it('produces a sensible headline for the fixture (risk-off, broadly down)', () => {
    const result = marketVerdict({
      regime: fixture.regime,
      market_context: fixture.market_context,
      validation: fixture.validation,
      quality: fixture.quality,
    });
    expect(result.headline).toBe("Risk-off, and it's broad.");
    expect(result.summary).toMatch(/still calibrating/);
    expect(result.facts.length).toBeGreaterThan(0);
    const joined = `${result.headline}\n${result.summary}\n${result.facts.join('\n')}`;
    expect(joined).not.toMatch(NO_LEAKED_VALUES);
  });
});

describe('sieveStages', () => {
  it('reports real counts from the frozen fixture, honestly labeled', () => {
    const fixture = loadFixture();
    const stages = sieveStages(fixture);
    const byKey = Object.fromEntries(stages.map((stage) => [stage.key, stage]));

    expect(byKey.scanned?.count).toBe(80);
    expect(byKey.priced?.count).toBe(50);
    expect(byKey.trusted?.count).toBe(50);
    expect(byKey.shortlisted?.count).toBe(12);
    expect(byKey.shortlisted?.label.toLowerCase()).not.toContain('passed');
  });

  it('omits a stage rather than rendering 0 when its data is missing', () => {
    const stages = sieveStages({});
    expect(stages).toEqual([]);
  });

  it('omits only the missing stages when some data is present', () => {
    const stages = sieveStages({ run: { row_count: 50 } });
    expect(stages).toHaveLength(1);
    expect(stages[0]?.key).toBe('priced');
    expect(stages[0]?.count).toBe(50);
  });
});
