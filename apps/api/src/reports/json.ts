import { stableStringify } from '../db/json.js';
import type { RunPayload } from '../pipeline/models.js';

/**
 * Round-trips through `stableStringify` for deterministic key order, then re-indents for
 * readability -- a direct `JSON.stringify(payload, null, 2)` would lose that ordering.
 */
export function renderJson(payload: RunPayload): string {
  const sorted: unknown = JSON.parse(stableStringify(payload));
  return JSON.stringify(sorted, null, 2);
}
