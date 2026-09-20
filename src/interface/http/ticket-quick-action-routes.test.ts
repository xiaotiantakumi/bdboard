import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  PriorityConflictError,
  StatusConflictError,
  type IssueWriterPort,
} from '../../application/ports/issue-writer.js';
import { LOCAL_ENV, withLocalHost, project, createFakeBoardCache, seedCache, createDeps } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns 501 when issue writer port is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'quick actions not available' });
  });
  it('posts a local quick-action claim', async () => {
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
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(issueWriter.claim).toHaveBeenCalledWith('/root/a', 'bdboard-a');
  });
  it('posts a local quick-action close with reason', async () => {
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
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close', reason: 'shipped' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(issueWriter.close).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'shipped',
    );
  });
  it('posts a local quick-action defer and priority', async () => {
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

    const deferResponse = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'defer', untilDate: '2026-08-22' }),
      }),
      LOCAL_ENV,
    );
    expect(deferResponse.status).toBe(200);
    expect(issueWriter.defer).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      '2026-08-22',
    );

    const priorityResponse = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'priority', priority: 2 }),
      }),
      LOCAL_ENV,
    );
    expect(priorityResponse.status).toBe(200);
    expect(issueWriter.setPriority).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      2,
    );
  });
  it('posts a local quick-action undefer', async () => {
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
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undefer' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(issueWriter.undefer).toHaveBeenCalledWith('/root/a', 'bdboard-a');
  });
  it('returns 409 without reporting fake success when the undefer quick action no longer applies (conflict)', async () => {
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
      // bdboard-3tw.93: `bd undefer` exits 0 and no-ops (rather than erroring)
      // when the ticket isn't currently deferred. The port's own CAS check
      // catches this and rejects with StatusConflictError instead of silently
      // doing nothing.
      undefer: vi.fn(async () => {
        throw new StatusConflictError('bdboard-a', 'deferred', 'open');
      }),
      undoPriority: vi.fn(async () => {}),
      updateTitle: vi.fn(async () => {}),
      updateDescription: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undefer' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'status changed since quick action',
      detail:
        'status for bdboard-a changed since the quick action ran (expected deferred, current open)',
      expectedStatus: 'deferred',
      currentStatus: 'open',
    });
  });
  it('returns 403 for undefer quick-action POST through tunnel headers', async () => {
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
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ action: 'undefer' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
    expect(issueWriter.undefer).not.toHaveBeenCalled();
  });
  it('returns 400 for invalid quick-action body', async () => {
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
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bogus' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(400);
  });
  it('returns 403 for quick-action POST through tunnel headers', async () => {
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
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
  });
  it('returns 404 for quick-action POST when ticket is not in cache', async () => {
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
      '/api/tickets/missing-ticket/quick-action',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'ticket not found', id: 'missing-ticket' });
  });
  it('returns 501 when issue writer port is not configured for quick-action undo', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'quick actions not available' });
  });
  it('undoes a claim quick-action via unclaim', async () => {
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
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(issueWriter.unclaim).toHaveBeenCalledWith('/root/a', 'bdboard-a');
    expect(issueWriter.claim).not.toHaveBeenCalled();
  });
  it('undoes a close quick-action via reopen', async () => {
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
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(issueWriter.reopen).toHaveBeenCalledWith('/root/a', 'bdboard-a');
  });
  it('undoes a defer quick-action via undefer', async () => {
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
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'defer' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(issueWriter.undefer).toHaveBeenCalledWith('/root/a', 'bdboard-a');
  });
  it('undoes an undefer quick-action by deferring back to the original date', async () => {
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
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'undefer',
          untilDate: '2026-08-10',
        }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(issueWriter.defer).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      '2026-08-10',
    );
  });
  it('returns 409 without reporting fake success when the close undo (reopen) no longer applies (conflict)', async () => {
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
      // bdboard-3tw.93: `bd reopen` exits 0 and no-ops (rather than erroring)
      // when the ticket isn't currently closed. The port's own CAS check (bd
      // show vs. the 'closed' precondition) catches this and rejects with
      // StatusConflictError instead of silently doing nothing.
      reopen: vi.fn(async () => {
        throw new StatusConflictError('bdboard-a', 'closed', 'in_progress');
      }),
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
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'status changed since quick action',
      detail:
        'status for bdboard-a changed since the quick action ran (expected closed, current in_progress)',
      expectedStatus: 'closed',
      currentStatus: 'in_progress',
    });
  });
  it('returns 409 without reporting fake success when the defer undo (undefer) no longer applies (conflict)', async () => {
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
      // bdboard-3tw.93: `bd undefer` exits 0 and no-ops (rather than erroring)
      // when the ticket isn't currently deferred. The port's own CAS check
      // catches this and rejects with StatusConflictError instead of silently
      // doing nothing.
      undefer: vi.fn(async () => {
        throw new StatusConflictError('bdboard-a', 'deferred', 'closed');
      }),
      undoPriority: vi.fn(async () => {}),
      updateTitle: vi.fn(async () => {}),
      updateDescription: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'defer' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'status changed since quick action',
      detail:
        'status for bdboard-a changed since the quick action ran (expected deferred, current closed)',
      expectedStatus: 'deferred',
      currentStatus: 'closed',
    });
  });
  it('undoes a priority quick-action by restoring the previous priority when the current value still matches', async () => {
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
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'priority',
          previousPriority: 3,
          expectedCurrentPriority: 1,
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    // The CAS check and the write-back are both delegated to the port's
    // undoPriority — routes.ts must not fall back to the unguarded
    // setPriority for the undo path (that would reintroduce bdboard-3tw.82).
    expect(issueWriter.undoPriority).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      1,
      3,
    );
    expect(issueWriter.setPriority).not.toHaveBeenCalled();
  });
  it('returns 409 without writing when priority changed since the quick action ran (conflict)', async () => {
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
      // Simulates another session having changed the priority between the
      // quick action and the Undo click: the port's own CAS check (bd show
      // vs. expectedCurrentPriority) fails and rejects with
      // PriorityConflictError instead of writing.
      undoPriority: vi.fn(async () => {
        throw new PriorityConflictError('bdboard-a', 1, 2);
      }),
      updateTitle: vi.fn(async () => {}),
      updateDescription: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'priority',
          previousPriority: 3,
          expectedCurrentPriority: 1,
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'priority changed since quick action',
      detail:
        'priority for bdboard-a changed since the quick action ran (expected 1, current 2)',
      expectedPriority: 1,
      currentPriority: 2,
    });
    expect(issueWriter.setPriority).not.toHaveBeenCalled();
  });
  it('returns 400 for invalid quick-action undo body', async () => {
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

    // priority undo without previousPriority must be rejected: silently
    // defaulting would restore the wrong value instead of surfacing the
    // missing precondition.
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'priority' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(400);
    expect(issueWriter.setPriority).not.toHaveBeenCalled();
    expect(issueWriter.undoPriority).not.toHaveBeenCalled();
  });
  it('returns 400 for priority quick-action undo missing expectedCurrentPriority', async () => {
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

    // expectedCurrentPriority is the CAS check's expected value (bdboard-3tw.82).
    // Without it the route cannot detect a conflict, so it must be rejected
    // rather than silently skipping the check.
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'priority', previousPriority: 3 }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(400);
    expect(issueWriter.undoPriority).not.toHaveBeenCalled();
  });
  it('returns 400 for undefer quick-action undo missing untilDate', async () => {
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
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undefer' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(400);
    expect(issueWriter.defer).not.toHaveBeenCalled();
  });
  it('returns 403 for quick-action undo POST through tunnel headers', async () => {
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
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
    expect(issueWriter.unclaim).not.toHaveBeenCalled();
  });
  it('returns 404 for quick-action undo POST when ticket is not in cache', async () => {
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
      '/api/tickets/missing-ticket/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'ticket not found', id: 'missing-ticket' });
  });
  it('returns 502 with detail when undo of claim fails (e.g. assignee changed since claim)', async () => {
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
      unclaim: vi.fn(async () => {
        throw new BdError(
          'unknown',
          'bdboard-a',
          'issue is assigned to a different actor',
        );
      }),
      undefer: vi.fn(async () => {}),
      undoPriority: vi.fn(async () => {}),
      updateTitle: vi.fn(async () => {}),
      updateDescription: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: 'failed to undo quick action',
      detail: 'issue is assigned to a different actor',
    });
  });
});
