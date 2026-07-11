import { asRecord } from './wire';

/**
 * Safe accessors for the API's `unknown`-typed payload blobs -- regime, market_context,
 * provider_status, validation are all `z.record(z.string(), z.unknown())` on the wire (see
 * packages/contracts/src/dashboard.ts). Every read here is type-checked before it's trusted;
 * nothing is ever cast with `as any`/`as number`.
 */

/** Returns `obj[key]` only if it is a finite `number`, else `null`. No string coercion. */
export function num(obj: unknown, key: string): number | null {
  const value = asRecord(obj)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Returns `obj[key]` only if it is a `string`, else `null`. */
export function str(obj: unknown, key: string): string | null {
  const value = asRecord(obj)[key];
  return typeof value === 'string' ? value : null;
}

/** Returns `obj[key]` only if it is a plain object, else `null`. Use to drill into nested blobs. */
export function rec(obj: unknown, key: string): Record<string, unknown> | null {
  const value = asRecord(obj)[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Returns `obj[key]` only if it is an array, else `[]`. */
export function arr(obj: unknown, key: string): unknown[] {
  const value = asRecord(obj)[key];
  return Array.isArray(value) ? value : [];
}

/**
 * pct/signedPct delegate to lib/format.ts (fmtRate/fmtPct) so there is one formatting
 * implementation, not two -- these are just the names/shape this module's callers (verdict.ts)
 * expect for values already pulled out of a payload blob via num() above.
 */
export { fmtPct as signedPct, fmtRate as pct } from './format';
