'use server';

import { API_BASE_URL } from './config';
import { errorMessage } from './errors';

/**
 * Server Actions used from Client Components need their own 'use server' file — Next.js forbids
 * an inline directive in a module that also ends up in a client bundle (ReloadButton.tsx pulls
 * lib/api.ts into the client graph, which is why triggerRefresh() can't live there).
 */

export type RefreshResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: string };

/**
 * Token is a server-only secret. apps/web and apps/api run as sibling processes sharing one env
 * (scripts/start.mjs), so it's safe to read here — it never reaches the browser.
 */
export async function triggerRefresh(): Promise<RefreshResult> {
  const token = process.env.CRYPTO_DASHBOARD_REFRESH_TOKEN;
  if (!token) {
    return { ok: false, error: 'CRYPTO_DASHBOARD_REFRESH_TOKEN is not configured' };
  }

  let response: Response;
  try {
    response = await fetch(new URL('/api/refresh', API_BASE_URL), {
      method: 'POST',
      headers: { 'X-Refresh-Token': token },
      cache: 'no-store',
    });
  } catch (cause) {
    return {
      ok: false,
      error: `Could not reach the dashboard API at ${API_BASE_URL}: ${errorMessage(cause)}`,
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Best-effort JSON; a non-JSON body still leaves status usable.
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `Refresh request failed with ${response.status} ${response.statusText}`,
    };
  }

  return { ok: true, status: response.status, body };
}
