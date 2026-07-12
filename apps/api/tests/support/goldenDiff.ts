/**
 * The deep-equality routine behind both golden oracles (parity.test.ts, dashboardPayload.test.ts).
 *
 * Deliberately stricter than toEqual: objects are compared on their full key SETS, so a field
 * silently added or dropped fails just as loudly as a wrong value. That is the whole point of an
 * oracle — do not loosen this to make a test pass.
 */

const FLOAT_TOLERANCE = 1e-9;

export function collectDiffs(
  actual: unknown,
  expected: unknown,
  path: string,
  diffs: string[],
): void {
  if (expected === null) {
    if (actual !== null) {
      diffs.push(`${path}: expected null, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (typeof expected === 'number') {
    if (
      typeof actual !== 'number' ||
      !Number.isFinite(actual) ||
      Math.abs(actual - expected) > FLOAT_TOLERANCE
    ) {
      diffs.push(`${path}: expected ${expected}, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (typeof expected === 'string' || typeof expected === 'boolean') {
    if (actual !== expected) {
      diffs.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push(`${path}: expected an array, got ${JSON.stringify(actual)}`);
      return;
    }
    if (actual.length !== expected.length) {
      diffs.push(
        `${path}: expected array of length ${expected.length}, got length ${actual.length}`,
      );
      return;
    }
    expected.forEach((item, index) => {
      collectDiffs(actual[index], item, `${path}[${index}]`, diffs);
    });
    return;
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null) {
      diffs.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    const expectedKeys = Object.keys(expected as Record<string, unknown>).sort();
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort();
    const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
    const extra = actualKeys.filter((key) => !expectedKeys.includes(key));
    if (missing.length > 0) {
      diffs.push(`${path}: missing key(s) ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      diffs.push(`${path}: unexpected extra key(s) ${extra.join(', ')}`);
    }
    for (const key of expectedKeys) {
      if (actualKeys.includes(key)) {
        collectDiffs(
          (actual as Record<string, unknown>)[key],
          (expected as Record<string, unknown>)[key],
          `${path}.${key}`,
          diffs,
        );
      }
    }
    return;
  }
  throw new Error(`collectDiffs: unhandled expected type at ${path}: ${typeof expected}`);
}

/** `maxDiffs` caps only how much of the failure is printed; it never affects pass/fail. */
export function assertMatches(
  actual: unknown,
  expected: unknown,
  label: string,
  maxDiffs = 50,
): void {
  const diffs: string[] = [];
  collectDiffs(actual, expected, label, diffs);
  if (diffs.length > 0) {
    const report = diffs.slice(0, maxDiffs).join('\n');
    const more = diffs.length > maxDiffs ? `\n... and ${diffs.length - maxDiffs} more` : '';
    throw new Error(`${diffs.length} mismatch(es) under ${label}:\n${report}${more}`);
  }
}
