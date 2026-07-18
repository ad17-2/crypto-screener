import { describe, expect, it } from 'vitest';
import { fmtPrice, ordinal } from '../lib/format';

describe('ordinal', () => {
  it('uses st/nd/rd for 1, 2, 3', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
  });

  it('uses th for the teens, which are the exception', () => {
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
  });

  it('resumes st/nd/rd past the teens', () => {
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(22)).toBe('22nd');
    expect(ordinal(23)).toBe('23rd');
    // The bug this replaced rendered "81th".
    expect(ordinal(81)).toBe('81st');
  });

  it('uses th for everything else, including 0 and 100', () => {
    expect(ordinal(0)).toBe('0th');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(38)).toBe('38th');
    expect(ordinal(100)).toBe('100th');
  });

  it('rounds before choosing the suffix', () => {
    expect(ordinal(80.6)).toBe('81st');
    expect(ordinal(11.4)).toBe('11th');
  });
});

describe('fmtPrice', () => {
  it('uses 2dp for prices >= 100', () => {
    expect(fmtPrice(67234.5)).toBe('$67234.50');
    expect(fmtPrice(100)).toBe('$100.00');
  });

  it('uses 4dp for prices >= 1 and < 100', () => {
    expect(fmtPrice(1)).toBe('$1.0000');
    expect(fmtPrice(67.234567)).toBe('$67.2346');
  });

  it('uses 6dp for prices below 1', () => {
    expect(fmtPrice(0.99)).toBe('$0.990000');
    expect(fmtPrice(0.000123)).toBe('$0.000123');
  });

  it('scales by magnitude, not sign', () => {
    expect(fmtPrice(-150)).toBe('$-150.00');
    expect(fmtPrice(-0.5)).toBe('$-0.500000');
  });

  it('returns "Price unavailable" for null, undefined, and non-numeric input', () => {
    expect(fmtPrice(null)).toBe('Price unavailable');
    expect(fmtPrice(undefined)).toBe('Price unavailable');
    expect(fmtPrice('not-a-number')).toBe('Price unavailable');
    expect(fmtPrice(Number.NaN)).toBe('Price unavailable');
  });

  it('coerces a numeric string, like numeric() does for the rest of the file', () => {
    expect(fmtPrice('42.5')).toBe('$42.5000');
  });
});
