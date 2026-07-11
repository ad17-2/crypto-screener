import type { RequestHandler } from 'express';
import { buildDashboardPayload } from '../../dashboard/payload.js';
import type { AppDeps } from '../app.js';

function firstQueryValue(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' ? candidate : undefined;
}

/** `refresh_status` is injected here, not by buildDashboardPayload — kept out of the payload builder for the parity fixture gate. */
export function dashboardRoute(
  deps: Pick<AppDeps, 'db' | 'config' | 'limit' | 'runtime'>,
): RequestHandler {
  return (req, res) => {
    const runId = firstQueryValue(req.query.run_id);
    const payload = buildDashboardPayload(
      deps.db,
      deps.config,
      runId !== undefined ? { runId, limit: deps.limit } : { limit: deps.limit },
    );
    res.json({ ...payload, refresh_status: deps.runtime.getStatus() });
  };
}
