import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import { respondBdError } from './bd-error-response.js';
import {
  findProjectRootPathForTicket,
  createRefreshAfterWrite,
} from './ticket-write-shared.js';
import type { ApiDeps } from './api-deps.js';

// 上限は ticket-decision-routes.ts の decisionBodySchema と揃える。どちらの値も
// 最終的に bd の argv に載るので、無制限だと spawn が E2BIG で落ち、exitCode:-1 が
// classifyBdError に bd-not-found と誤分類される (bdboard-xgvh レビュー指摘)。
const commentBodySchema = z.object({
  text: z.string().min(1).max(2000),
});

export function createTicketCommentWriteRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const refreshAfterWrite = createRefreshAfterWrite(deps);

  app.post('/api/tickets/:id/comment', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'comments not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, commentBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.addComment(rootPath, id, parsed.data.text);

      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to add comment', error);
    }
  });

  return app;
}
