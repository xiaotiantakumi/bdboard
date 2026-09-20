import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  type IssueWriterPort,
} from '../../application/ports/issue-writer.js';
import { LOCAL_ENV, withLocalHost, project, createFakeBoardCache, seedCache, createDeps } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns 501 when issue writer port is not configured for comment POST', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'comments not available' });
  });
  it('posts a local comment', async () => {
    const cache = createFakeBoardCache();
    seedCache(cache, [
      { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
    ]);

    const issueWriter: IssueWriterPort = {
      claim: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      defer: vi.fn(async () => {}),
      setPriority: vi.fn(async () => {}),
      addComment: vi.fn(async () => {}),
      reopen: vi.fn(async () => {}),
      unclaim: vi.fn(async () => {}),
      undefer: vi.fn(async () => {}),
      undoPriority: vi.fn(async () => {}),
      updateTitle: vi.fn(async () => {}),
      updateDescription: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'progress update' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(issueWriter.addComment).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'progress update',
    );
  });
  it('returns 400 for empty comment body', async () => {
    const issueWriter: IssueWriterPort = {
      claim: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      defer: vi.fn(async () => {}),
      setPriority: vi.fn(async () => {}),
      addComment: vi.fn(async () => {}),
      reopen: vi.fn(async () => {}),
      unclaim: vi.fn(async () => {}),
      undefer: vi.fn(async () => {}),
      undoPriority: vi.fn(async () => {}),
      updateTitle: vi.fn(async () => {}),
      updateDescription: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(400);
    expect(issueWriter.addComment).not.toHaveBeenCalled();
  });
  it('returns 403 for comment POST through tunnel headers', async () => {
    const issueWriter: IssueWriterPort = {
      claim: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      defer: vi.fn(async () => {}),
      setPriority: vi.fn(async () => {}),
      addComment: vi.fn(async () => {}),
      reopen: vi.fn(async () => {}),
      unclaim: vi.fn(async () => {}),
      undefer: vi.fn(async () => {}),
      undoPriority: vi.fn(async () => {}),
      updateTitle: vi.fn(async () => {}),
      updateDescription: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      withLocalHost({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ text: 'hello' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
    expect(issueWriter.addComment).not.toHaveBeenCalled();
  });
  it('returns 502 when comment writer fails', async () => {
    const cache = createFakeBoardCache();
    seedCache(cache, [
      { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
    ]);

    const issueWriter: IssueWriterPort = {
      claim: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      defer: vi.fn(async () => {}),
      setPriority: vi.fn(async () => {}),
      addComment: vi.fn(async () => {
        throw new BdError('lock-contention', 'bdboard-a', 'database is locked');
      }),
      reopen: vi.fn(async () => {}),
      unclaim: vi.fn(async () => {}),
      undefer: vi.fn(async () => {}),
      undoPriority: vi.fn(async () => {}),
      updateTitle: vi.fn(async () => {}),
      updateDescription: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: 'failed to add comment',
      detail: 'database is locked',
    });
  });
});
