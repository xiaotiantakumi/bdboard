import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { makeTicket } from '../../domain/test-support.js';
import {
  ContentConflictError,
  type IssueWriterPort,
} from '../../application/ports/issue-writer.js';
import { NOW, LOCAL_ENV, withLocalHost, project, createFakeBoardCache, seedCache, createDeps } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns 501 when issue writer port is not configured for title update', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request(
      '/api/tickets/bdboard-a/title',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New title',
          expectedCurrentTitle: 'Old title',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'ticket content editing not available' });
  });
  it('returns 501 when issue writer port is not configured for description update', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request(
      '/api/tickets/bdboard-a/description',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'New description',
          expectedCurrentDescription: 'Old description',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'ticket content editing not available' });
  });
  it('patches a local ticket title', async () => {
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
      '/api/tickets/bdboard-a/title',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New title',
          expectedCurrentTitle: 'Old title',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(issueWriter.updateTitle).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'New title',
      'Old title',
    );
  });
  it('patches a local ticket description', async () => {
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
      '/api/tickets/bdboard-a/description',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'New description',
          expectedCurrentDescription: 'Old description',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(issueWriter.updateDescription).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'New description',
      'Old description',
    );
  });
  it('returns 409 when title changed since loaded (conflict)', async () => {
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
      updateTitle: vi.fn(async () => {
        throw new ContentConflictError(
          'bdboard-a',
          'title',
          'Old title',
          'Changed title',
        );
      }),
      updateDescription: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/title',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New title',
          expectedCurrentTitle: 'Old title',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'title changed since loaded',
      detail:
        'content for bdboard-a field title changed since it was loaded (expected "Old title", current "Changed title")',
      expectedTitle: 'Old title',
      currentTitle: 'Changed title',
    });
  });
  it('returns 409 when description changed since loaded (conflict)', async () => {
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
      updateDescription: vi.fn(async () => {
        throw new ContentConflictError(
          'bdboard-a',
          'description',
          'Old description',
          'Changed description',
        );
      }),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/description',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'New description',
          expectedCurrentDescription: 'Old description',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'description changed since loaded',
      detail:
        'content for bdboard-a field description changed since it was loaded (expected "Old description", current "Changed description")',
      expectedDescription: 'Old description',
      currentDescription: 'Changed description',
    });
  });
  it('returns 400 for invalid title update body', async () => {
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
      '/api/tickets/bdboard-a/title',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '', expectedCurrentTitle: 'Old title' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'invalid request body' });
    expect(issueWriter.updateTitle).not.toHaveBeenCalled();
  });
  it('returns 400 for invalid description update body', async () => {
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
      '/api/tickets/bdboard-a/description',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'x'.repeat(4001),
          expectedCurrentDescription: 'Old description',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'invalid request body' });
    expect(issueWriter.updateDescription).not.toHaveBeenCalled();
  });
  it('returns 404 when patching title for an unknown ticket', async () => {
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
      '/api/tickets/bdboard-missing/title',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New title',
          expectedCurrentTitle: 'Old title',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'ticket not found', id: 'bdboard-missing' });
    expect(issueWriter.updateTitle).not.toHaveBeenCalled();
  });
  it('returns 404 when patching description for an unknown ticket', async () => {
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
      '/api/tickets/bdboard-missing/description',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'New description',
          expectedCurrentDescription: 'Old description',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'ticket not found', id: 'bdboard-missing' });
    expect(issueWriter.updateDescription).not.toHaveBeenCalled();
  });
});
