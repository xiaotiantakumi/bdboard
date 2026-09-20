import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import { isSafeCliArgument } from '../../domain/chat.js';
import { ContentConflictError } from '../../application/ports/issue-writer.js';
import { respondBdError } from './bd-error-response.js';
import {
  findProjectRootPathForTicket,
  createRefreshAfterWrite,
} from './ticket-write-shared.js';
import type { ApiDeps } from './routes.js';

const updateTitleBodySchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .refine(isSafeCliArgument, { message: 'unsafe title' }),
  expectedCurrentTitle: z.string().max(200),
});

const updateDescriptionBodySchema = z.object({
  description: z.string().max(4000),
  expectedCurrentDescription: z.string().max(4000),
});

export function createTicketContentRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const refreshAfterWrite = createRefreshAfterWrite(deps);

  app.patch('/api/tickets/:id/title', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'ticket content editing not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, updateTitleBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.updateTitle(
        rootPath,
        id,
        parsed.data.title,
        parsed.data.expectedCurrentTitle,
      );
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof ContentConflictError) {
        return c.json(
          {
            error: 'title changed since loaded',
            detail: error.message,
            expectedTitle: error.expectedValue,
            currentTitle: error.actualValue,
          },
          409,
        );
      }

      return respondBdError(c, 'failed to update title', error);
    }
  });

  app.patch('/api/tickets/:id/description', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'ticket content editing not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, updateDescriptionBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.updateDescription(
        rootPath,
        id,
        parsed.data.description,
        parsed.data.expectedCurrentDescription,
      );
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof ContentConflictError) {
        return c.json(
          {
            error: 'description changed since loaded',
            detail: error.message,
            expectedDescription: error.expectedValue,
            currentDescription: error.actualValue,
          },
          409,
        );
      }

      return respondBdError(c, 'failed to update description', error);
    }
  });

  return app;
}
