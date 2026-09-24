import { Hono } from 'hono';
import { getMergeSlotStatus } from '../../application/board/get-merge-slot-status.js';
import { toMergeSlotStatusDto } from './dto.js';
import { parseProjectIds } from './api-route-shared.js';
import type { ApiDeps } from './api-deps.js';

// bdboard-sso1.61: hygiene-routes.ts (旧284行、5ルートが同居) の分割で
// GET /api/merge-slot-status をここへ切り出した (move only, 挙動変更ゼロ)。

export function createMergeSlotStatusRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/api/merge-slot-status', async (c) => {
    if (deps.mergeSlotReader === undefined) {
      return c.json({ error: 'merge slot status not available' }, 501);
    }

    const projectIds = parseProjectIds(c.req.query('projects'));
    const projects = deps.cache.listProjects().map((entry) => entry.project);
    const statuses = await getMergeSlotStatus(
      projects,
      deps.mergeSlotReader,
      deps.now(),
      projectIds !== undefined ? { projectIds } : undefined,
    );

    return c.json(statuses.map(toMergeSlotStatusDto));
  });

  return app;
}
