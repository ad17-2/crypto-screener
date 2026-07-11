import type Database from 'better-sqlite3';
import { pyRound } from '../pipeline/scoring.js';

const EXPLICIT_OFFSET_PATTERN = /(Z|[+-]\d{2}:\d{2})$/;

/**
 * No offset/Z suffix is assumed UTC here — deliberately different from
 * db/time.ts::parseGeneratedAt, which assumes +07:00. Do not unify them. Returns null if unparseable.
 */
function parseIsoAssumingUtc(text: string): Date | null {
  const withOffset = EXPLICIT_OFFSET_PATTERN.test(text) ? text : `${text}Z`;
  const parsed = new Date(withOffset);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface FreshnessSummary {
  status: string;
  label: string;
  generated_at?: string;
  age_seconds: number | null;
  age_minutes: number | null;
  help?: string;
}

export function freshnessSummary(generatedAt: string | null | undefined): FreshnessSummary {
  if (!generatedAt) {
    return { status: 'unknown', label: 'unknown', age_seconds: null, age_minutes: null };
  }
  const parsed = parseIsoAssumingUtc(generatedAt);
  if (parsed === null) {
    return {
      status: 'unknown',
      label: 'unknown',
      generated_at: generatedAt,
      age_seconds: null,
      age_minutes: null,
    };
  }
  const ageSeconds = Math.max(0.0, (Date.now() - parsed.getTime()) / 1000.0);
  let label: string;
  if (ageSeconds <= 4 * 60 * 60) {
    label = 'fresh';
  } else if (ageSeconds <= 12 * 60 * 60) {
    label = 'aging';
  } else if (ageSeconds <= 24 * 60 * 60) {
    label = 'stale';
  } else {
    label = 'old';
  }
  return {
    status: 'ok',
    label,
    generated_at: generatedAt,
    age_seconds: pyRound(ageSeconds, 0),
    age_minutes: pyRound(ageSeconds / 60.0, 1),
    help: 'Freshness is based on the selected saved run, not live tick data.',
  };
}

export function latestRunGeneratedAt(db: Database.Database): Date | null {
  const row = db
    .prepare('SELECT generated_at FROM runs ORDER BY generated_at DESC LIMIT 1')
    .get() as { generated_at: string } | undefined;
  if (row === undefined) {
    return null;
  }
  return parseIsoAssumingUtc(row.generated_at);
}

export function latestRunAgeSeconds(db: Database.Database): number | null {
  const generatedAt = latestRunGeneratedAt(db);
  if (generatedAt === null) {
    return null;
  }
  return Math.max(0.0, (Date.now() - generatedAt.getTime()) / 1000.0);
}
