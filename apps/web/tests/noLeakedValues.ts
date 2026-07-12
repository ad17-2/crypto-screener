/**
 * Word-bounded on purpose: an unanchored /null|NaN|undefined/i also fires inside ordinary English
 * ("domi-nan-ce"), which fails on correct output. We only care about these as leaked *values*.
 */
export const NO_LEAKED_VALUES = /\b(null|NaN|undefined)\b/i;
