import { DIRECTIONAL_FACTORS } from './factorDefinitions.js';
import { toFloat } from './scoring.js';
import type { Row } from './types.js';
import { asRecord } from './types.js';

// Sign comes from the pre-rounding value (handles -0), not the rounded value.
export function formatSigned(value: number, decimals: number): string {
  const sign = value < 0 || Object.is(value, -0) ? '-' : '+';
  return `${sign}${Math.abs(value).toFixed(decimals)}`;
}

function appendMetric(
  parts: string[],
  label: string,
  value: unknown,
  decimals: number,
  suffix: string,
): void {
  const numeric = toFloat(value);
  if (numeric !== null) {
    parts.push(`${label} ${formatSigned(numeric, decimals)}${suffix}`);
  }
}

export function reasonFor(row: Row, side: string): string {
  const parts: string[] = [];
  const factors = asRecord(row.factors);
  const scores = asRecord(row.scores);
  const qualityFlags = Array.isArray(row.data_quality_flags) ? row.data_quality_flags : [];

  appendMetric(parts, '24h', row.price_change_24h_pct, 2, '%');
  appendMetric(parts, 'OI', row.oi_change_24h_pct, 2, '%');
  appendMetric(parts, 'funding', row.funding_rate_pct, 4, '%');
  if (row.long_short_ratio !== null && row.long_short_ratio !== undefined) {
    const ratio = toFloat(row.long_short_ratio) ?? 0.0;
    parts.push(`L/S ${ratio.toFixed(2)}`);
  }
  const factorScore = toFloat(scores.factor_score);
  if (factorScore !== null) {
    parts.push(`factor ${formatSigned(factorScore, 2)}`);
  }
  const confidenceScore = toFloat(scores.confidence_score);
  if (confidenceScore !== null) {
    parts.push(`confidence ${confidenceScore.toFixed(0)}`);
  }
  const conflictLabel = row.signal_conflict_label;
  if (conflictLabel && conflictLabel !== 'aligned') {
    parts.push(`signals ${String(conflictLabel)}`);
  }
  if (row.technical_setup) {
    parts.push(`tech ${String(row.technical_setup)}`);
  }

  const strongest = Object.entries(factors)
    .filter((entry): entry is [string, unknown] => DIRECTIONAL_FACTORS.includes(entry[0]))
    .map(([name, value]) => [name, toFloat(value)] as const)
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 2);
  for (const [name, value] of strongest) {
    if (Math.abs(value) >= 0.5) {
      parts.push(`${name} ${formatSigned(value, 2)}`);
    }
  }

  if (side === 'fade-long') {
    parts.push('crowded long conditions');
  }
  if (side === 'squeeze-risk') {
    parts.push('crowded short conditions');
  }
  if (qualityFlags.length > 0) {
    parts.push(`excluded: ${qualityFlags.map((flag) => String(flag)).join(', ')}`);
  }
  return parts.join('; ');
}
