import type { Request, RequestHandler } from 'express';
import { isRefreshAllowed } from '../../env.js';
import type { AppDeps } from '../app.js';

/** Bearer wins when both X-Refresh-Token and Authorization are supplied — not an "either" fallback. */
function suppliedToken(req: Request): string {
  let supplied = req.get('X-Refresh-Token') ?? '';
  const auth = req.get('Authorization') ?? '';
  if (auth.startsWith('Bearer ')) {
    supplied = auth.slice('Bearer '.length).trim();
  }
  return supplied;
}

// Matches klines.ts's own firstQueryValue -- Express parses a repeated query key as an array, so
// this always resolves to the single string value a route actually wants.
function firstQueryValue(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' ? candidate : undefined;
}

function isRefreshMode(value: string): value is 'light' | 'full' {
  return value === 'light' || value === 'full';
}

/** Default-deny: with no token configured, `isRefreshAllowed` always returns false — there is no open mode. */
export function refreshRoute(deps: Pick<AppDeps, 'refreshToken' | 'runtime'>): RequestHandler {
  return (req, res) => {
    if (!isRefreshAllowed(deps.refreshToken, suppliedToken(req))) {
      res.status(403).json({ status: 'forbidden', reason: 'refresh token required' });
      return;
    }

    const modeRaw = firstQueryValue(req.query.mode);
    if (modeRaw !== undefined && !isRefreshMode(modeRaw)) {
      res.status(400).json({ status: 'invalid_request', reason: 'mode must be "full" or "light"' });
      return;
    }

    // Always 202; in-flight state is signaled via the body ({"state": "running"}), not the status code.
    res.status(202).json(deps.runtime.refreshAsync('manual', modeRaw));
  };
}
