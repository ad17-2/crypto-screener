import { describe, expect, it } from 'vitest';
import { ordinal } from '../lib/format';

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
