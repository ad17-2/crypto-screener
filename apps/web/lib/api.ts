import type { DashboardPayload } from '@crypto-screener/contracts';
import { DashboardPayloadSchema } from '@crypto-screener/contracts';
import { API_BASE_URL } from './config';
import { errorMessage } from './errors';

export type DashboardResult =
  | { ok: true; payload: DashboardPayload }
  | { ok: false; error: string };

/** Never throws; callers get a typed ok/error result instead of wrapping every call in try/catch. */
export async function getDashboard(runId?: string): Promise<DashboardResult> {
  const url = new URL('/api/dashboard', API_BASE_URL);
  if (runId) {
    url.searchParams.set('run_id', runId);
  }

  let response: Response;
  try {
    // Live DB state — never cache this fetch.
    response = await fetch(url, { cache: 'no-store' });
  } catch (cause) {
    return {
      ok: false,
      error: `Could not reach the dashboard API at ${API_BASE_URL}: ${errorMessage(cause)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `Dashboard API responded with ${response.status} ${response.statusText}`,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (cause) {
    return { ok: false, error: `Dashboard API returned invalid JSON: ${errorMessage(cause)}` };
  }

  const parsed = DashboardPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `Dashboard payload failed validation: ${parsed.error.message}` };
  }

  return { ok: true, payload: parsed.data };
}
