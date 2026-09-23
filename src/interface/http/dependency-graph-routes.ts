import { Hono } from 'hono';
import { getDependencyGraph } from '../../application/board/get-dependency-graph.js';
import { toDependencyGraphDto } from './dto.js';
import { parseProjectIds } from './api-route-shared.js';
import type { ApiDeps } from './routes.js';

// bdboard-sso1.61: hygiene-routes.ts (旧284行、5ルートが同居) の分割で
// GET /api/graph をここへ切り出した (move only, 挙動変更ゼロ)。

export function createDependencyGraphRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/api/graph', (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const graph = getDependencyGraph(deps.cache, {
      ...(projectIds !== undefined ? { projectIds } : {}),
    });
    return c.json(toDependencyGraphDto(graph));
  });

  return app;
}
