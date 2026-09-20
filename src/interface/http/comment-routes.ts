import { Hono } from 'hono';
import { getBoard } from '../../application/board/get-board.js';
import { toCommentDto } from './dto.js';
import { respondBdError } from './bd-error-response.js';
import { buildGetBoardDeps } from './api-route-shared.js';
import type { ApiDeps } from './routes.js';

export function createCommentRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/api/comments/:id{.+}', async (c) => {
    if (deps.commentReader === undefined) {
      return c.json({ error: 'comments not available' }, 501);
    }

    const id = c.req.param('id');
    const view = await getBoard(await buildGetBoardDeps(deps), { mode: 'merged' });

    const card = view.merged?.cards.find((entry) => entry.ticket.id === id);
    if (card === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const cached = deps.cache.getProject(card.projectId);
    if (cached === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      const comments = await deps.commentReader.listComments(
        cached.project.rootPath,
        card.ticket.id,
      );
      return c.json(comments.map(toCommentDto));
    } catch (error: unknown) {
      return respondBdError(c, 'failed to load comments', error);
    }
  });

  return app;
}
