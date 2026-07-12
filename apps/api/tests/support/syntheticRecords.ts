import type { FactorRecord } from '../../src/pipeline/ic.js';

export function strongPositive(
  periodIdx: number,
  symIdx: number,
  rank: number,
  nSymbols: number,
): [number, number] {
  const forward = symIdx === periodIdx % nSymbols ? (rank + 1) % nSymbols : rank;
  return [forward, rank];
}

export function weakIc(
  periodIdx: number,
  symIdx: number,
  rank: number,
  nSymbols: number,
): [number, number] {
  return [(symIdx + periodIdx) % nSymbols, rank];
}

export function splitIcRecords(
  factor: string,
  nPeriods: number,
  trainFn: typeof strongPositive,
  testFn: typeof strongPositive,
  nSymbols = 5,
): FactorRecord[] {
  const splitIndex = Math.max(15, Math.trunc(0.6 * nPeriods));
  const records: FactorRecord[] = [];
  for (let periodIdx = 0; periodIdx < nPeriods; periodIdx += 1) {
    const generatedAt = `2024-01-${String(periodIdx + 1).padStart(2, '0')}T12:00:00+07:00`;
    const forwardFn = periodIdx < splitIndex ? trainFn : testFn;
    for (let symIdx = 0; symIdx < nSymbols; symIdx += 1) {
      const rank = symIdx;
      const [forwardReturnPct, factorValue] = forwardFn(periodIdx, symIdx, rank, nSymbols);
      records.push({
        symbol: `S${symIdx}`,
        generated_at: generatedAt,
        forward_return_pct: forwardReturnPct,
        factors: { [factor]: factorValue },
      });
    }
  }
  return records;
}
