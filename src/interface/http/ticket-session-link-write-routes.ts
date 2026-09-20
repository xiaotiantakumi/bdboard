import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import { respondBdError } from './bd-error-response.js';
import {
  findProjectRootPathForTicket,
  createRefreshAfterWrite,
} from './ticket-write-shared.js';
import type { ApiDeps } from './routes.js';

const sessionLinkBodySchema = z.object({
  sessionId: z.string().min(1).max(200),
});

export function createTicketSessionLinkWriteRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const refreshAfterWrite = createRefreshAfterWrite(deps);

  app.post('/api/tickets/:id/session-link', async (c) => {
    if (deps.sessionLinkWriter === undefined) {
      return c.json({ error: 'session linking not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, sessionLinkBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.sessionLinkWriter.linkSession(
        rootPath,
        id,
        parsed.data.sessionId,
      );
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to link session', error);
    }
  });

  app.delete('/api/tickets/:id/session-link', async (c) => {
    if (deps.sessionLinkWriter === undefined) {
      return c.json({ error: 'session linking not available' }, 501);
    }

    const id = c.req.param('id');

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.sessionLinkWriter.unlinkSession(rootPath, id);
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to unlink session', error);
    }
  });

  return app;
}
