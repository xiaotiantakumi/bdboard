import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import type { IssueComment } from '../../domain/issue-comment.js';
import { makeTicket } from '../../domain/test-support.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { NOW, project, createFakeBoardCache, createDeps } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns comments for a ticket on the board', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const ticketId = 'bdboard-3tw.10';
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: ticketId,
          projectId: a.id,
          commentCount: 2,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const comments: IssueComment[] = [
      {
        id: 'comment-1',
        issueId: ticketId,
        author: 'Alice',
        text: 'First',
        createdAt: new Date('2026-08-14T10:00:00Z'),
      },
      {
        id: 'comment-2',
        issueId: ticketId,
        author: 'Bob',
        text: 'Second',
        createdAt: new Date('2026-08-14T11:00:00Z'),
      },
    ];

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => comments),
    };

    const app = createApiRoutes(createDeps({ cache, commentReader }));
    const response = await app.request(`/api/comments/${ticketId}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      {
        id: 'comment-1',
        issueId: ticketId,
        author: 'Alice',
        text: 'First',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
      {
        id: 'comment-2',
        issueId: ticketId,
        author: 'Bob',
        text: 'Second',
        createdAt: '2026-08-14T11:00:00.000Z',
      },
    ]);
    expect(commentReader.listComments).toHaveBeenCalledWith('/projects/a', ticketId);
    expect(response.headers.get('ETag')).toBeNull();
  });
  it('returns 404 for comments when ticket is missing', async () => {
    const commentReader: CommentReader = {
      listComments: vi.fn(async () => []),
    };
    const app = createApiRoutes(createDeps({ commentReader }));
    const response = await app.request('/api/comments/missing-ticket');
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'ticket not found', id: 'missing-ticket' });
    expect(commentReader.listComments).not.toHaveBeenCalled();
  });
  it('returns 502 when comment reader fails', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const ticketId = 'bdboard-3tw.10';
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: ticketId, projectId: a.id, commentCount: 1 })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => {
        throw new BdError('lock-contention', ticketId, 'database is locked');
      }),
    };

    const app = createApiRoutes(createDeps({ cache, commentReader }));
    const response = await app.request(`/api/comments/${ticketId}`);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: 'failed to load comments',
      detail: 'database is locked',
    });
  });
  it('returns 501 when comment reader is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/comments/bdboard-abc');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'comments not available' });
  });
});
