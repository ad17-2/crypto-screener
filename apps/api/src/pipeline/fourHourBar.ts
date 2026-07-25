// CoinGlass (Hobbyist tier) locks futures history to 4h candles that close on the UTC bar edges
// 00/04/08/12/16/20 -- epoch 0 is UTC midnight and 4h divides a day evenly, so floor-dividing a
// timestamp by FOUR_H_MS and multiplying back lands exactly on those edges with no timezone
// offset needed. Backs the light/full refresh split (pipeline/runPipeline.ts): history fetched
// this bar cannot differ from history fetched anywhere else inside the same bar.
export const FOUR_H_MS = 4 * 60 * 60 * 1000;

export function fourHourBarStartMs(nowMs: number): number {
  return Math.floor(nowMs / FOUR_H_MS) * FOUR_H_MS;
}
