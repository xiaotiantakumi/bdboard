import { Hono } from 'hono';
import { z } from 'zod';
import { getAllProjectsHarnessStatus } from '../../application/harness/get-all-projects-harness-status.js';
import { getProjectHarnessStatus } from '../../application/harness/get-project-harness-status.js';
import { injectHarnessPack } from '../../application/harness/inject-harness-pack.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { HarnessInjectorPort } from '../../application/ports/harness-injector.js';
import type { PackRegistryPort } from '../../application/ports/pack-registry.js';
import type { ProjectHarnessStatus } from '../../domain/harness-pack.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';

export interface HarnessRoutesDeps {
  readonly cache: BoardCache;
  readonly registry: PackRegistryPort;
  readonly injector: HarnessInjectorPort;
  readonly now?: () => Date;
  readonly writeAccess?: WriteGuardDeps;
}

const injectBodySchema = z.object({
  pack: z.string().min(1).max(200),
});

function decodeProjectIdParam(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function extractProjectIdFromHarnessPath(reqPath: string): string | undefined {
  const prefix = '/api/projects/';
  const harnessSuffix = '/harness';
  const injectSuffix = '/harness/inject';

  if (reqPath.endsWith(injectSuffix)) {
    const encoded = reqPath.slice(prefix.length, reqPath.length - injectSuffix.length);
    return encoded.length > 0 ? decodeProjectIdParam(encoded) : undefined;
  }

  if (reqPath.endsWith(harnessSuffix)) {
    const encoded = reqPath.slice(prefix.length, reqPath.length - harnessSuffix.length);
    return encoded.length > 0 ? decodeProjectIdParam(encoded) : undefined;
  }

  return undefined;
}

function toHarnessStatusJson(status: ProjectHarnessStatus): Record<string, unknown> {
  return {
    packs: status.packs.map((entry) => ({
      name: entry.name,
      availableVersion: entry.availableVersion,
      installedVersion: entry.installedVersion,
      drift: entry.drift,
    })),
  };
}

async function resolveProjectHarnessStatus(
  deps: HarnessRoutesDeps,
  projectId: string,
): Promise<ProjectHarnessStatus | 'project-not-found'> {
  const cached = deps.cache.getProject(projectId);
  if (cached === undefined) {
    return 'project-not-found';
  }

  const manifest = await deps.injector.readManifest(cached.project.rootPath);
  return getProjectHarnessStatus(deps.registry, manifest);
}

export function createHarnessRoutes(deps: HarnessRoutesDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());

  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

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
      projects,
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

  app.post('/api/projects/*/harness/inject', async (c) => {
    const projectId = extractProjectIdFromHarnessPath(c.req.path);
    if (projectId === undefined) {
      return c.notFound();
    }

    const cached = deps.cache.getProject(projectId);
    if (cached === undefined) {
      return c.json({ error: 'project not found' }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = injectBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body', details: parsed.error.flatten() }, 400);
    }

    const result = await injectHarnessPack(
      {
        registry: deps.registry,
        injector: deps.injector,
        now,
      },
      cached.project.rootPath,
      parsed.data.pack,
    );

    if (!result.ok) {
      if (result.failure.kind === 'pack-not-found') {
        return c.json({ error: 'pack not found' }, 404);
      }
      return c.json({ error: 'injection failed', detail: result.failure.detail }, 500);
    }

    const status = await getProjectHarnessStatus(deps.registry, result.manifest);
    return c.json(toHarnessStatusJson(status));
  });

  return app;
}
