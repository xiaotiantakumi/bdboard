import { guardedApp, type AgentRunGuardToken } from './agent-run-guard.js';
import type { RunStore } from '../../application/runner/run-store.js';

/**
 * agent-run-routes.ts (旧672行) の分割 (bdboard-sso1.27) で
 * POST /api/runs/:runId/cancel をここへ切り出した (move only, 挙動変更ゼロ)。
 */

export interface AgentRunCancelRoutesDeps {
  readonly runStore: RunStore;
}

export function createAgentRunCancelRoutes(deps: AgentRunCancelRoutesDeps, guardToken: AgentRunGuardToken): void {
  // bdboard-v0df: guardedApp(guardToken) always resolves to the exact Hono instance the
  // guard was applied to. This factory mutates that instance in place and returns
  // nothing — there is no independently mountable app for a caller to redirect
  // elsewhere, or to remount under an unrelated path prefix.
  const app = guardedApp(guardToken);

  app.post('/api/runs/:runId/cancel', (c) => {
    const runId = c.req.param('runId');
    const record = deps.runStore.get(runId);
    if (record === undefined) {
      // Unknown run ids are 404 so clients can distinguish stale ids from finished runs.
      return c.json({ error: 'run not found' }, 404);
    }

    if (record.status !== 'running') {
      return c.json({ error: 'run is not running' }, 409);
    }

    const cancelled = deps.runStore.cancel(runId);
    return c.json({ runId, status: cancelled?.status ?? 'cancelling' }, 202);
  });
}
