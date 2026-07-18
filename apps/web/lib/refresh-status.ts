import { asRecord } from './wire';

/**
 * The API's `refresh_status` field is `z.unknown().nullable()` on the wire (packages/contracts
 * `dashboard.ts`) -- deliberately untightened, because its real shape
 * (apps/api/src/refresh/runtime.ts `RefreshStatus`) is a state-tagged union, and a re-entrant
 * quirk in the runtime can produce a `state: 'running'` object with leftover `'ok'` fields (e.g.
 * `finished_at`) spread into it. So every field below is read independently of `state` -- never
 * "only read `started_at` when state is 'running'" -- rather than trusting the union's shape.
 */

const KNOWN_STATES = new Set(['idle', 'running', 'ok', 'error']);

export interface ParsedRefreshStatus {
  state: 'idle' | 'running' | 'ok' | 'error';
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** `null` for an absent, malformed, or unrecognized-`state` value -- never guessed at. */
export function parseRefreshStatus(value: unknown): ParsedRefreshStatus | null {
  const obj = asRecord(value);
  const state = obj.state;
  if (typeof state !== 'string' || !KNOWN_STATES.has(state)) return null;

  return {
    state: state as ParsedRefreshStatus['state'],
    error: typeof obj.error === 'string' ? obj.error : null,
    startedAt: typeof obj.started_at === 'string' ? obj.started_at : null,
    finishedAt: typeof obj.finished_at === 'string' ? obj.finished_at : null,
  };
}

export interface RefreshStatusChip {
  text: string;
  tone: 'warn' | 'muted';
  /** The underlying error string, for a `title` attribute -- `null` when there is none to show. */
  title: string | null;
}

/**
 * `idle`/`ok` render no chip -- a healthy pipeline is quiet. The scheduler retries a failing
 * refresh every 5 minutes on its own, so the `error` chip's copy says so rather than implying the
 * user must act.
 */
export function refreshStatusChip(parsed: ParsedRefreshStatus | null): RefreshStatusChip | null {
  if (parsed === null) return null;
  if (parsed.state === 'error') {
    return { text: 'Refresh failing — retrying every 5 min', tone: 'warn', title: parsed.error };
  }
  if (parsed.state === 'running') {
    return { text: 'Refresh in progress', tone: 'muted', title: null };
  }
  return null;
}
