import { Hono } from 'hono';
import type { BoardCache } from '../../application/ports/board-cache.js';

export interface DbStatsRoutesDeps {
  readonly cache: BoardCache;
}

export function createDbStatsRoutes(deps: DbStatsRoutesDeps): Hono {
  const app = new Hono();

  app.get('/api/settings/db-stats', (c) => {
    const stats = deps.cache.getCacheStats();
    return c.json(stats);
  });

  return app;
}
