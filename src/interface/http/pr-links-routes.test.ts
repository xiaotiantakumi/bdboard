import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { makeTicket } from '../../domain/test-support.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { PrStatus } from '../../domain/pr-link.js';
import type { PrStatusReader } from '../../application/ports/pr-status-reader.js';
import { NOW, project, createFakeBoardCache, createDeps, assertNoDates } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns 501 when pr link dependencies are not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/pr-links');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'pr links not available' });
  });
  it('returns pr badges for tickets with PR comments', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const prUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/42';

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-pr',
          projectId: a.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-pr',
          author: 'agent',
          text: `PR: ${prUrl}`,
          createdAt: NOW,
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'open', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    const app = createApiRoutes(
      createDeps({ cache, commentReader, prStatusReader }),
    );
    const response = await app.request('/api/pr-links');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      {
        ticketId: 'bdboard-pr',
        projectId: 'proj-a',
        url: prUrl,
        state: 'open',
        checkStatus: 'pass',
      },
    ]);
    assertNoDates(body);
  });
  it('returns pr badges filtered by projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const b = project('proj-b', '/projects/b');
    const prUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/99';

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: a.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-b',
          projectId: b.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: `PR: ${prUrl}`,
          createdAt: NOW,
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'merged', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    const app = createApiRoutes(
      createDeps({ cache, commentReader, prStatusReader }),
    );
    const response = await app.request(
      `/api/pr-links?projects=${encodeURIComponent(b.id)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      ticketId: 'bdboard-b',
      projectId: 'proj-b',
      url: prUrl,
      state: 'merged',
      checkStatus: 'pass',
    });
    assertNoDates(body);
  });
});
