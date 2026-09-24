import { Hono } from 'hono';
import { getAllProjectsHarnessStatus } from '../../application/harness/get-all-projects-harness-status.js';
import { readProjectHarnessStatus } from '../../application/harness/get-project-harness-status.js';
import type { ProjectHarnessStatus } from '../../domain/harness-pack.js';
import type { HarnessRoutesDeps } from './harness-routes-deps.js';
import { extractProjectIdFromHarnessPath, toHarnessStatusJson } from './harness-routes-shared.js';

// harness-routes.ts (旧347行) の分割 (bdboard-sso1.56) で、ハーネス状態の読み取り系
// (GET /api/harness/packs・GET /api/harness/status・GET /api/projects/*/harness) を
// ここへ切り出した (move only, 挙動変更ゼロ)。

async function resolveProjectHarnessStatus(
  deps: HarnessRoutesDeps,
  projectId: string,
): Promise<ProjectHarnessStatus | 'project-not-found'> {
  const cached = deps.cache.getProject(projectId);
  if (cached === undefined) {
    return 'project-not-found';
  }

  return readProjectHarnessStatus(deps, cached.project.rootPath, deps.now?.());
}

export interface HarnessStatusRoutesParams {
  readonly now: () => Date;
}

export function createHarnessStatusRoutes(
  deps: HarnessRoutesDeps,
  { now }: HarnessStatusRoutesParams,
): Hono {
  const app = new Hono();

  app.get('/api/harness/packs', async (c) => {
    const packs = await deps.registry.listPacks();
    return c.json(
      packs.map((pack) => ({
        name: pack.name,
        version: pack.version,
        description: pack.description,
      })),
    );
  });

  app.get('/api/harness/status', async (c) => {
    const projects = deps.cache.listProjects().map((entry) => entry.project);
    const statuses = await getAllProjectsHarnessStatus({
      registry: deps.registry,
      injector: deps.injector,
      contractReader: deps.contractReader,
      projects,
      now: now(),
    });

    return c.json({
      projects: statuses.map(({ projectId, status }) => ({
        projectId,
        ...toHarnessStatusJson(status),
      })),
    });
  });

  app.get('/api/projects/*/harness', async (c) => {
    const projectId = extractProjectIdFromHarnessPath(c.req.path);
    if (projectId === undefined) {
      return c.notFound();
    }

    const status = await resolveProjectHarnessStatus(deps, projectId);
    if (status === 'project-not-found') {
      return c.json({ error: 'project not found' }, 404);
    }

    return c.json(toHarnessStatusJson(status));
  });

  return app;
}
