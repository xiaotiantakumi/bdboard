import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import { isSafeCliArgument } from '../../domain/chat.js';
import { respondBdError } from './bd-error-response.js';
import {
  findProjectRootPathForTicket,
  findCachedTicket,
  createRefreshAfterWrite,
} from './ticket-write-shared.js';
import type { ApiDeps } from './api-deps.js';

const labelBodySchema = z.object({
  label: z
    .string()
    .min(1)
    .max(200)
    .refine(isSafeCliArgument, { message: 'unsafe label' }),
});

export function createTicketLabelWriteRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const refreshAfterWrite = createRefreshAfterWrite(deps);

  app.post('/api/tickets/:id/labels', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'label editing not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, labelBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.addLabel(rootPath, id, parsed.data.label);
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to add label', error);
    }
  });

  app.delete('/api/tickets/:id/labels/:label{.+}', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'label editing not available' }, 501);
    }

    const id = c.req.param('id');
    const label = c.req.param('label');

    if (!isSafeCliArgument(label)) {
      return c.json({ error: 'invalid label' }, 400);
    }

    const cached = findCachedTicket(deps.cache, id);
    if (cached === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const currentLabels = cached.ticket.labels ?? [];
    if (!currentLabels.includes(label)) {
      return c.json(
        { error: 'label not found on this ticket', id, label },
        409,
      );
    }

    try {
      await deps.issueWriter.removeLabel(cached.rootPath, id, label);
      await refreshAfterWrite(cached.rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to remove label', error);
    }
  });

  return app;
}
