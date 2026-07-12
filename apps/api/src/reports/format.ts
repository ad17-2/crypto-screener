import { formatSigned, toFloat } from '../pipeline/scoring.js';

export function formatUsd(value: unknown): string {
  const numeric = toFloat(value);
  if (numeric === null) {
    return '-';
  }
  const absValue = Math.abs(numeric);
  if (absValue >= 1_000_000_000_000) {
    return `$${(numeric / 1_000_000_000_000).toFixed(2)}T`;
  }
  if (absValue >= 1_000_000_000) {
    return `$${(numeric / 1_000_000_000).toFixed(2)}B`;
  }
  if (absValue >= 1_000_000) {
    return `$${(numeric / 1_000_000).toFixed(2)}M`;
  }
  if (absValue >= 1_000) {
    return `$${(numeric / 1_000).toFixed(2)}K`;
  }
  return `$${numeric.toFixed(2)}`;
}

export function formatPct(value: unknown, digits = 2, signed = true): string {
  const numeric = toFloat(value);
  if (numeric === null) {
    return '-';
  }
  const body = signed ? formatSigned(numeric, digits) : numeric.toFixed(digits);
  return `${body}%`;
}
