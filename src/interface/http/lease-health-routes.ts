import { Hono } from 'hono';
import { getStaleLeaseIssues } from '../../application/board/get-stale-lease-issues.js';
import { toLeaseHealthDto } from './dto.js';
import { parseProjectIds } from './api-route-shared.js';
import type { ApiDeps } from './api-deps.js';

// bdboard-sso1.61: hygiene-routes.ts (旧284行、5ルートが同居) の分割で
// GET /api/lease-health をここへ切り出した (move only, 挙動変更ゼロ)。

export function createLeaseHealthRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/api/lease-health', async (c) => {
    if (deps.leaseReader === undefined || deps.reclaimScheduler === undefined) {
      return c.json({ error: 'lease health not available' }, 501);
    }

    const projectIds = parseProjectIds(c.req.query('projects'));
    const projects = deps.cache.listProjects().map((entry) => entry.project);
    const staleLeases = await getStaleLeaseIssues(
      projects,
      deps.leaseReader,
      deps.now(),
      projectIds !== undefined ? { projectIds } : undefined,
    );

    return c.json(
      toLeaseHealthDto({
        staleLeases,
        reclaim: deps.reclaimScheduler.getStatus(),
      }),
    );
  });

  return app;
}
