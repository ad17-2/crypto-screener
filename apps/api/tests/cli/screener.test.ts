import { describe, expect, it, vi } from 'vitest';

const { runPipelineMock } = vi.hoisted(() => ({ runPipelineMock: vi.fn() }));

vi.mock('../../src/pipeline/runPipeline.js', () => ({ runPipeline: runPipelineMock }));

const { main } = await import('../../src/cli/screener.js');

describe('screener CLI', () => {
  it('prints the locked stdout contract, in order, and forwards --no-save/--no-reports', async () => {
    const payload = {
      run_id: 'run-cli',
      rows: [
        // Long/short membership is an observation (the coin advanced/declined), not a factor_score.
        // Directional rows carry the full-signal fields (btc_beta/btc_correlation/atr_14_pct)
        // required by the membership gate; the crowding rows below deliberately do not.
        {
          symbol: 'LONG',
          price_change_24h_pct: 5,
          factor_score: 0.5,
          long_score: 10,
          is_trusted: true,
          btc_beta: 1.1,
          btc_correlation: 0.7,
          atr_14_pct: 4.2,
        },
        {
          symbol: 'SHORT',
          price_change_24h_pct: -5,
          factor_score: -0.5,
          short_score: 11,
          is_trusted: true,
          btc_beta: 0.9,
          btc_correlation: 0.6,
          atr_14_pct: 3.8,
        },
        {
          symbol: 'FADE',
          factor_score: 0.1,
          crowded_long_score: 12,
          funding_rate_pct: 0.02,
          is_trusted: true,
        },
        {
          symbol: 'SQUEEZE',
          factor_score: -0.1,
          squeeze_risk_score: 13,
          funding_rate_pct: -0.02,
          is_trusted: true,
        },
      ],
      regime: { bias: 'risk-on', label: 'neutral' },
    };
    runPipelineMock.mockResolvedValueOnce({ payload, paths: {} });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const exitCode = await main([
        '--config',
        'config/default.json',
        '--out-dir',
        '/tmp/crypto-screener-cli-test',
        '--no-save',
        '--no-reports',
      ]);

      expect(exitCode).toBe(0);
      expect(runPipelineMock).toHaveBeenCalledOnce();
      expect(runPipelineMock.mock.calls[0]?.[1]).toBe('/tmp/crypto-screener-cli-test');
      expect(runPipelineMock.mock.calls[0]?.[2]).toEqual({ save: false, writeReportFiles: false });

      expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
        'run_id=run-cli',
        'screened_symbols=4',
        'bias=risk-on',
        'factor_regime=neutral',
        'long_candidates=1',
        'short_candidates=1',
        'crowded_longs=1',
        'squeeze_risks=1',
        'reports=skipped',
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prints one {label}={path} line per report file when reports were written', async () => {
    const payload = {
      run_id: 'run-cli-2',
      rows: [],
      regime: { bias: 'mixed', label: 'chaos' },
    };
    runPipelineMock.mockResolvedValueOnce({
      payload,
      paths: { json: '/tmp/out/run.json', csv: '/tmp/out/run.csv', markdown: '/tmp/out/run.md' },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const exitCode = await main(['--config', 'config/default.json', '--out-dir', '/tmp/out']);

      expect(exitCode).toBe(0);
      const lines = logSpy.mock.calls.map((call) => call[0]);
      expect(lines).not.toContain('reports=skipped');
      expect(lines).toEqual(
        expect.arrayContaining([
          'json=/tmp/out/run.json',
          'csv=/tmp/out/run.csv',
          'markdown=/tmp/out/run.md',
        ]),
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
