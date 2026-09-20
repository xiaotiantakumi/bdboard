import { Hono } from 'hono';
import { getBoardTimeZoneOverride } from '../../config/board-timezone.js';
import type { ApiDeps } from './routes.js';

export function createHealthStatusRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const applicationVersion = deps.applicationVersion.getVersion();

  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      now: deps.now().toISOString(),
      version: applicationVersion,
      ...(deps.instanceNonce !== undefined ? { instanceNonce: deps.instanceNonce } : {}),
    });
  });

  app.get('/api/status', (c) => {
    const status = deps.getStatus();
    return c.json({
      lastRefreshAt:
        status.lastRefreshAt !== null
          ? status.lastRefreshAt.toISOString()
          : null,
      errors: status.errors.map((error) => ({
        kind: error.kind,
        projectId: error.projectId,
        detail: error.detail,
      })),
      projectCount: status.projectCount,
      boardTimeZone: getBoardTimeZoneOverride() ?? null,
    });
  });

  return app;
}
