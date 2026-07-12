import { describe, expect, it } from 'vitest';
import { ONE_BET_FACTOR, oneBetEvidence } from '../lib/one-bet';

function modelWeights(factors: unknown[]): unknown {
  return { factors };
}

describe('oneBetEvidence', () => {
  it('is locked to reversal_3d specifically, not whichever factor happens to be validated', () => {
    expect(ONE_BET_FACTOR).toBe('reversal_3d');
  });

  it('returns null when reversal_3d is absent from model_weights.factors', () => {
    expect(
      oneBetEvidence(modelWeights([{ name: 'momentum_24h', edge_verdict: 'validated' }])),
    ).toBeNull();
  });

  it('returns null on a completely empty payload', () => {
    expect(oneBetEvidence({})).toBeNull();
  });

  it('reads validated: true only when edge_verdict is exactly "validated"', () => {
    const evidence = oneBetEvidence(
      modelWeights([
        {
          name: 'reversal_3d',
          edge_verdict: 'validated',
          net_spread_pct: 0.42,
          net_edge_per_30d_pct: 1.8,
          edge_t_stat: 2.6,
          edge_train_net_spread_pct: 0.5,
          edge_validation_net_spread_pct: 0.3,
        },
      ]),
    );
    expect(evidence).toEqual({
      validated: true,
      edgeVerdict: 'validated',
      netSpreadPct: 0.42,
      netEdgePer30dPct: 1.8,
      edgeTStat: 2.6,
      trainNetSpreadPct: 0.5,
      validationNetSpreadPct: 0.3,
    });
  });

  it.each([
    'failed-forward',
    'failed-train',
    'insufficient-data',
  ])('reads validated: false for edge_verdict %s -- a train-only pass must not read as validated', (verdict) => {
    const evidence = oneBetEvidence(modelWeights([{ name: 'reversal_3d', edge_verdict: verdict }]));
    expect(evidence?.validated).toBe(false);
    expect(evidence?.edgeVerdict).toBe(verdict);
  });

  it('reads validated: false when edge_verdict is missing entirely', () => {
    const evidence = oneBetEvidence(modelWeights([{ name: 'reversal_3d' }]));
    expect(evidence?.validated).toBe(false);
    expect(evidence?.edgeVerdict).toBeNull();
  });

  it('never throws on malformed field types', () => {
    expect(() =>
      oneBetEvidence(
        modelWeights([{ name: 'reversal_3d', edge_verdict: 42, net_spread_pct: 'not-a-number' }]),
      ),
    ).not.toThrow();
  });
});
