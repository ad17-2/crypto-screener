/**
 * numeric() feeds sort/comparators, where `Number(null) === 0` is fine. `fmt*` functions feed
 * display, where null/undefined render as "-" so absent never looks like zero. Do not unify.
 */

/** `numeric(null) === 0`, not `null`. */
export function numeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function fmtNum(value: unknown, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return Number(value).toFixed(digits);
}

export function fmtPct(value: unknown, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/** No leading sign, unlike fmtPct — don't merge the two. */
export function fmtRate(value: unknown, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return `${Number(value).toFixed(digits)}%`;
}

export function fmtUsd(value: unknown): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const n = Number(value);
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/** "1st", "2nd", "3rd", "11th", "21st". The teens are the trap: 11/12/13 take "th", not st/nd/rd. */
export function ordinal(value: number): string {
  const n = Math.round(value);
  const mod100 = Math.abs(n) % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (Math.abs(n) % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function clsFor(value: unknown): string {
  const n = Number(value || 0);
  if (n > 0) return 'text-up';
  if (n < 0) return 'text-down';
  return '';
}

export function arrowPct(value: unknown, digits = 2): string {
  const n = numeric(value);
  if (n === null) return fmtPct(value, digits);
  const mark = n > 0 ? '▲ ' : n < 0 ? '▼ ' : '';
  return `${mark}${fmtPct(value, digits)}`;
}

export type QualityTone = 'bad' | 'warn' | '';

export function qualityTone(value: unknown): QualityTone {
  const q = numeric(value);
  if (q === null || q < 75) return 'bad';
  if (q < 90) return 'warn';
  return '';
}

export type ConflictTone = 'pos' | 'bad' | 'warn' | 'neutral';

export function conflictTone(label: unknown): ConflictTone {
  const normalized = String(label ?? '').toLowerCase();
  if (normalized === 'aligned' || normalized === 'neutral') return 'pos';
  if (normalized === 'high-conflict' || normalized === 'excluded') return 'bad';
  if (normalized && normalized !== 'unknown') return 'warn';
  return 'neutral';
}

export function confluenceToneClass(tone: string): string {
  if (tone === 'pos') return 'conf-pos';
  if (tone === 'neg') return 'conf-neg';
  return 'conf-neutral';
}
