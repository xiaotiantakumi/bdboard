import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import { respondBdError } from './bd-error-response.js';
import {
  findProjectRootPathForTicket,
  findCachedTicket,
  createRefreshAfterWrite,
} from './ticket-write-shared.js';
import type { ApiDeps } from './routes.js';

const dependencyBodySchema = z.object({
  dependsOnId: z.string().min(1).max(200),
});

export function createTicketDependencyWriteRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const refreshAfterWrite = createRefreshAfterWrite(deps);

  app.post('/api/tickets/:id/dependencies', async (c) => {
    if (deps.dependencyWriter === undefined) {
      return c.json({ error: 'dependency editing not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, dependencyBodySchema);
    if (!parsed.ok) return parsed.response;

    const { dependsOnId } = parsed.data;

    if (dependsOnId === id) {
      return c.json({ error: 'cannot depend on itself' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const dependsOnRootPath = findProjectRootPathForTicket(
      deps.cache,
      dependsOnId,
    );
    if (dependsOnRootPath === undefined || dependsOnRootPath !== rootPath) {
      return c.json(
        { error: 'dependency target must be in the same project' },
        400,
      );
    }

    try {
      await deps.dependencyWriter.addDependency(rootPath, id, dependsOnId);
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to add dependency', error);
    }
  });

  app.delete('/api/tickets/:id/dependencies/:dependsOnId{.+}', async (c) => {
    if (deps.dependencyWriter === undefined) {
      return c.json({ error: 'dependency editing not available' }, 501);
    }

    const id = c.req.param('id');
    const dependsOnId = c.req.param('dependsOnId');

    const cached = findCachedTicket(deps.cache, id);
    if (cached === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const edge = cached.ticket.dependencies.find(
      (dependency) => dependency.dependsOnId === dependsOnId,
    );
    // キャッシュに無いエッジは bd に投げずにここで弾く。削除ボタンはキャッシュ上の
    // blocks エッジにしか出ないので、見つからない = クライアントが古い、ということ。
    // そのまま bd dep remove へ流すと、キャッシュが stale な間に parent-child を
    // 消してしまいうる(kind を判定できないため)。破壊的操作なので fail-closed にする。
    if (edge === undefined) {
      return c.json(
        { error: 'dependency not found on this ticket', id, dependsOnId },
        409,
      );
    }
    if (edge.kind !== 'blocks') {
      return c.json(
        { error: 'only blocks dependencies can be removed', kind: edge.kind },
        400,
      );
    }

    try {
      await deps.dependencyWriter.removeDependency(
        cached.rootPath,
        id,
        dependsOnId,
      );
      await refreshAfterWrite(cached.rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to remove dependency', error);
    }
  });

  return app;
}
