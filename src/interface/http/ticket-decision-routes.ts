import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import { respondBdError } from './bd-error-response.js';
import {
  findProjectRootPathForTicket,
  createRefreshAfterWrite,
} from './ticket-write-shared.js';
import type { ApiDeps } from './api-deps.js';

// 上限は ticket-comment-write-routes.ts の commentBodySchema と揃える。どちらの値も
// 最終的に bd の argv に載るので、無制限だと spawn が E2BIG で落ち、exitCode:-1 が
// classifyBdError に bd-not-found と誤分類される (bdboard-xgvh レビュー指摘)。
const decisionBodySchema = z.object({
  choice: z.string().min(1).max(2000).optional(),
  freeform: z.string().min(1).max(2000).optional(),
});

export function createTicketDecisionRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const refreshAfterWrite = createRefreshAfterWrite(deps);

  app.post('/api/tickets/:id/decision', async (c) => {
    if (deps.humanDecisions === undefined) {
      return c.json({ error: 'pending decisions not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, decisionBodySchema);
    if (!parsed.ok) return parsed.response;

    const trimmedFreeform = parsed.data.freeform?.trim();
    const responseText =
      trimmedFreeform !== undefined && trimmedFreeform.length > 0
        ? trimmedFreeform
        : parsed.data.choice;

    if (responseText === undefined || responseText.length === 0) {
      return c.json({ error: 'choice or freeform is required' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      const outcome = await deps.humanDecisions.respond(rootPath, id, responseText);
      await refreshAfterWrite(rootPath);
      return c.json({
        ok: true,
        outcome: {
          kind: outcome.kind,
          closed: outcome.closed,
          ...(outcome.resolvedGateIds !== undefined
            ? { resolvedGateIds: outcome.resolvedGateIds }
            : {}),
          ...(outcome.clearedHumanLabelTicketIds !== undefined
            ? { clearedHumanLabelTicketIds: outcome.clearedHumanLabelTicketIds }
            : {}),
          ...(outcome.ambiguousGateIds !== undefined
            ? { ambiguousGateIds: outcome.ambiguousGateIds }
            : {}),
        },
      });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to respond', error);
    }
  });

  return app;
}
