/**
 * `generated_at` is stored with a fixed +07:00 offset; history queries compare it as TEXT with
 * `>=`/`<=`, relying on ISO lexical order == chronological order. "Now" cutoffs must use this
 * same +07:00 offset, not the host's ambient timezone (containers default to UTC).
 */
const STORAGE_OFFSET_MINUTES = 7 * 60;
const STORAGE_OFFSET_SUFFIX = '+07:00';
const EXPLICIT_OFFSET_PATTERN = /(Z|[+-]\d{2}:\d{2})$/;

export function formatJakartaIso(date: Date): string {
  const shifted = new Date(date.getTime() + STORAGE_OFFSET_MINUTES * 60_000);
  return `${shifted.toISOString().slice(0, 19)}${STORAGE_OFFSET_SUFFIX}`;
}

/** Legacy rows with no offset/Z suffix are assumed to be Asia/Jakarta (+07:00) local time. */
export function parseGeneratedAt(text: string): Date {
  const withOffset = EXPLICIT_OFFSET_PATTERN.test(text) ? text : `${text}${STORAGE_OFFSET_SUFFIX}`;
  return new Date(withOffset);
}

export function horizonTolerance(hours: number): [min: number, max: number] {
  return [hours * 0.75, hours * 1.5];
}

/** Ties keep the first candidate (strict `<`). `targetHours` need not be the tolerance band's midpoint — callers decide. */
export function selectHorizonMatch<T>(
  items: Array<{ value: T; deltaHours: number }>,
  minTargetHours: number,
  maxTargetHours: number,
  targetHours: number,
): T | null {
  let best: T | null = null;
  let bestDistance: number | null = null;
  for (const { value, deltaHours } of items) {
    if (deltaHours < minTargetHours || deltaHours > maxTargetHours) {
      continue;
    }
    const distance = Math.abs(deltaHours - targetHours);
    if (best === null || bestDistance === null || distance < bestDistance) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
}
