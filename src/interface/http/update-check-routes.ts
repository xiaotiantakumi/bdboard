import { Hono } from 'hono';
import type { UpdateCheckService } from '../../application/update/get-update-check.js';
import type { UpdateCheck } from '../../domain/update-check.js';

export interface UpdateCheckRoutesDeps {
  readonly updateCheckService: UpdateCheckService;
}

function toResponseJson(state: UpdateCheck): Record<string, unknown> {
  if (state.kind === 'update-available') {
    return {
      state: 'update-available',
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      releaseUrl: state.releaseUrl,
    };
  }
  return { state: state.kind, currentVersion: state.currentVersion };
}

export function createUpdateCheckRoutes(deps: UpdateCheckRoutesDeps): Hono {
  const app = new Hono();

  app.get('/api/update-check', async (c) => {
    return c.json(toResponseJson(await deps.updateCheckService.getUpdateCheck()));
  });

  return app;
}
