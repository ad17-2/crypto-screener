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

/** Default-deny: with no token configured, `isRefreshAllowed` always returns false — there is no open mode. */
export function refreshRoute(deps: Pick<AppDeps, 'refreshToken' | 'runtime'>): RequestHandler {
  return (req, res) => {
    if (!isRefreshAllowed(deps.refreshToken, suppliedToken(req))) {
      res.status(403).json({ status: 'forbidden', reason: 'refresh token required' });
      return;
    }
    // Always 202; in-flight state is signaled via the body ({"state": "running"}), not the status code.
    res.status(202).json(deps.runtime.refreshAsync('manual'));
  };
}
