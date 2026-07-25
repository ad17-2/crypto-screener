import { describe, expect, it } from 'vitest';
import { screenerSectorRotation } from '../../src/pipeline/market.js';
import type { Row } from '../../src/pipeline/types.js';

function row(symbol: string, residual: number | null, isTrusted = true): Row {
  const built: Row = { symbol, is_trusted: isTrusted };
  if (residual !== null) {
    built.residual_change_24h_pct = residual;
  }
  return built;
}

describe('screenerSectorRotation', () => {
  it('medians an odd-count sector as the middle value', () => {
    const rows = [row('BTC', 1), row('ETH', 9), row('SOL', 5)];
    const sectorMembers = { 'Layer 1': ['BTC', 'ETH', 'SOL'] };

    const result = screenerSectorRotation(rows, sectorMembers, 3);

    expect(result).toEqual([{ sector: 'Layer 1', median_residual_change_24h_pct: 5, n: 3 }]);
  });

  it('medians an even-count sector as the average of the two middle values', () => {
    const rows = [row('UNI', 1), row('AAVE', 2), row('MKR', 3), row('LDO', 4)];
    const sectorMembers = { DeFi: ['UNI', 'AAVE', 'MKR', 'LDO'] };

    const result = screenerSectorRotation(rows, sectorMembers, 4);

    // (2 + 3) / 2 = 2.5
    expect(result).toEqual([{ sector: 'DeFi', median_residual_change_24h_pct: 2.5, n: 4 }]);
  });

  it('drops a sector whose matched-and-valued member count is below the floor', () => {
    const rows = [row('RENDER', 1), row('FET', 2), row('WLD', 3)];
    // 3 valid members, floor of 4 -- thin, drop it.
    const sectorMembers = { AI: ['RENDER', 'FET', 'WLD'] };

    const result = screenerSectorRotation(rows, sectorMembers, 4);

    expect(result).toEqual([]);
  });

  it('excludes a member row with a null residual_change_24h_pct from both the median and n', () => {
    // WLD never got residualised (no btc_beta/btc_change_24h_pct match in rowScoring.ts), so it
    // carries no residual_change_24h_pct field at all -- same as an explicit null.
    const rows = [row('RENDER', 1), row('FET', 3), row('WLD', null)];
    const sectorMembers = { AI: ['RENDER', 'FET', 'WLD'] };

    const result = screenerSectorRotation(rows, sectorMembers, 2);

    // Median of [1, 3] = 2, n=2 -- WLD counts toward neither.
    expect(result).toEqual([{ sector: 'AI', median_residual_change_24h_pct: 2, n: 2 }]);
  });

  it('counts a coin belonging to more than one sector toward each sector independently', () => {
    const rows = [row('LINK', 10), row('UNI', 2), row('RENDER', 6)];
    const sectorMembers = {
      DeFi: ['LINK', 'UNI'],
      AI: ['LINK', 'RENDER'],
    };

    const result = screenerSectorRotation(rows, sectorMembers, 2);

    expect(result).toEqual([
      // AI: median([10, 6]) = 8, ranks first (descending sort).
      { sector: 'AI', median_residual_change_24h_pct: 8, n: 2 },
      // DeFi: median([10, 2]) = 6.
      { sector: 'DeFi', median_residual_change_24h_pct: 6, n: 2 },
    ]);
  });

  it('yields an empty result for an empty member map', () => {
    const rows = [row('BTC', 1), row('ETH', 2)];

    const result = screenerSectorRotation(rows, {}, 1);

    expect(result).toEqual([]);
  });

  it('matches symbols case-insensitively, both in the member list and on the row', () => {
    const rows = [row('btc', 4), row('ETH', 6)];
    const sectorMembers = { 'Layer 1': ['BTC', 'eth'] };

    const result = screenerSectorRotation(rows, sectorMembers, 2);

    expect(result).toEqual([{ sector: 'Layer 1', median_residual_change_24h_pct: 5, n: 2 }]);
  });

  it("excludes an untrusted row from a sector median (mirrors this file's other summaries, which all filter to trusted rows)", () => {
    const rows = [row('BTC', 1), row('ETH', 9, false)];
    const sectorMembers = { 'Layer 1': ['BTC', 'ETH'] };

    const result = screenerSectorRotation(rows, sectorMembers, 1);

    expect(result).toEqual([{ sector: 'Layer 1', median_residual_change_24h_pct: 1, n: 1 }]);
  });

  it('sorts multiple surviving sectors by median residual descending, using the real config sector names and realistic member counts', () => {
    // Mirrors the live universe intersection measured 2026-07-25 (see config/schema.ts's
    // providers.coingecko.sectors comment): layer-1(30)/DeFi(19)/AI(11)/meme(6)/layer-2(4)/gaming(3)
    // scaled down here to a handful of rows per sector, well above/below the floor as noted.
    const rows = [
      // Layer 1: strong positive rotation, 4 members.
      row('BTC', 8),
      row('ETH', 10),
      row('SOL', 12),
      row('NEAR', 14),
      // DeFi: mild positive rotation, 3 members, LINK shared with AI below.
      row('UNI', 1),
      row('AAVE', 3),
      row('LINK', 5),
      // AI: negative rotation, 3 members. LINK (5, shared from above) pulls the median up.
      row('TAO', -6),
      row('FET', -2),
      // Meme: 3 members listed, but WIF never residualised (null) -- only 2 valid, below the
      // floor of 3, so the whole sector is dropped even though every listed symbol matched a row.
      row('DOGE', 20),
      row('PEPE', 22),
      row('WIF', null),
    ];
    const sectorMembers = {
      'Layer 1': ['BTC', 'ETH', 'SOL', 'NEAR'],
      DeFi: ['UNI', 'AAVE', 'LINK'],
      AI: ['LINK', 'TAO', 'FET'],
      Meme: ['DOGE', 'PEPE', 'WIF'],
    };

    const result = screenerSectorRotation(rows, sectorMembers, 3);

    expect(result.map((entry) => entry.sector)).toEqual(['Layer 1', 'DeFi', 'AI']);
    expect(result).toEqual([
      // median([8, 10, 12, 14]) = 11
      { sector: 'Layer 1', median_residual_change_24h_pct: 11, n: 4 },
      // median([1, 3, 5]) = 3
      { sector: 'DeFi', median_residual_change_24h_pct: 3, n: 3 },
      // median([5, -6, -2]) = -2
      { sector: 'AI', median_residual_change_24h_pct: -2, n: 3 },
    ]);
  });
});
