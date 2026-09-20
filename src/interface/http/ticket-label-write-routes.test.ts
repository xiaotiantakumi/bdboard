import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { makeTicket } from '../../domain/test-support.js';
import {
  type IssueWriterPort,
} from '../../application/ports/issue-writer.js';
import { NOW, LOCAL_ENV, withLocalHost, project, createFakeBoardCache, seedCache, createDeps } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns 501 when issue writer port is not configured for label add', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request(
      '/api/tickets/bdboard-a/labels',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'human' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'label editing not available' });
  });
  it('posts a local label add', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: proj.id })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

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
      '/api/tickets/bdboard-a/labels',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'human' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(issueWriter.addLabel).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'human',
    );
  });
  it('returns 400 for unsafe label on add', async () => {
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
      '/api/tickets/bdboard-a/labels',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: '-rf' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'invalid request body' });
    expect(issueWriter.addLabel).not.toHaveBeenCalled();
  });
  it('deletes a local label', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: proj.id,
          labels: ['human'],
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

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
      '/api/tickets/bdboard-a/labels/human',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(issueWriter.removeLabel).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'human',
    );
  });
  it('returns 409 when deleting a label absent from cache', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: proj.id })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

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
      '/api/tickets/bdboard-a/labels/human',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'label not found on this ticket',
      id: 'bdboard-a',
      label: 'human',
    });
    expect(issueWriter.removeLabel).not.toHaveBeenCalled();
  });
});
