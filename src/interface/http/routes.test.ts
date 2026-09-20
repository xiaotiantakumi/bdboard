import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes, type ApiDeps } from './routes.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import { makeTicket } from '../../domain/test-support.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import type { DependencyWriterPort } from '../../application/ports/dependency-writer.js';
import type { SessionLinkWriterPort } from '../../application/ports/session-link-writer.js';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  ContentConflictError,
  PriorityConflictError,
  StatusConflictError,
  type IssueWriterPort,
} from '../../application/ports/issue-writer.js';
import { NOW, LOCAL_ENV, withLocalHost, project, createFakeBoardCache, seedCache, createDeps } from './routes-test-support.js';

describe('createApiRoutes', () => {

  // bdboard-wadg: bd/ に紐づかない worktree (feature/* 等) は HygieneIssue の形に乗らない
  // ため、/api/hygiene のチケット issues とは別に nonTicketHarnessWorktrees で返す。
  // bdboard-cjsa: このレーンは生存セッション (cwd がその worktree の内側にある alive な
  // セッション) がある worktree だけを対象にするので、ここでは cwd の合う生存セッションを
  // 明示的に用意する。
  // bdboard-cjsa レビュー指摘: 元のこのテストは non-ticket worktree を snapshot に
  // 一切含めていなかったため、結果が空になる理由が「scanner が測れない」なのか
  // 「そもそも non-ticket worktree が無い」なのか区別できていなかった。feature/*
  // worktree と生存セッションを足し、gate は通るが scanner 側が測れない、という
  // ケースを明示的に作る。
  // bdboard-cjsa 本題: 生存セッションのゲーティング。セッションが無い/死んでいる/cwd が
  // 別の worktree を指している場合は、放棄済みとみなして警告からもコミット遅れ計測からも
  // 除外する。
  // bdboard-xjzj: bdboard-wadg (PR #480) の Opus レビュー指摘。既存テストは全て proj-a
  // (in_progress チケット持ち) だけを使うため、routes.ts の
  // `for (const worktree of nonTicketWorktrees) { measuredProjectIds.add(...) }` を
  // 削除してもどのテストも落ちない = ミューテーション未検出だった。in_progress チケットを
  // 一切持たない proj-b を用意し、getProjectMainBranch が proj-b に対しても呼ばれ、
  // nonTicketHarnessWorktrees の baseRef が解決された main branch (develop) を正しく
  // 反映することをアサートする。
  // 世代を listProjects() 全体ではなく、メモのキーになったプロジェクトだけから作ることの回帰ガード
  it('posts a local decision response with freeform preferred over choice', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: projectA, ticketId: 'bdboard-a' }]);

    const respond = vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false }));
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond,
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          choice: 'yes',
          freeform: '  free text answer  ',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      outcome: { kind: 'ticket', closed: false },
    });
    expect(respond).toHaveBeenCalledWith(
      '/projects/a',
      'bdboard-a',
      'free text answer',
    );
  });

  it('posts a local decision response with choice only', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: projectA, ticketId: 'bdboard-a' }]);

    const respond = vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false }));
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond,
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      outcome: { kind: 'ticket', closed: false },
    });
    expect(respond).toHaveBeenCalledWith('/projects/a', 'bdboard-a', 'yes');
  });

  // bdboard-v78e レビュー指摘#3: respond() が返す ambiguousGateIds (bdboard-q1k9) が
  // HTTP レスポンスまで確実に転送されることを固定する配線テスト。web/src/api.ts 側の
  // 単体テストは fetch のレスポンス JSON を直接モックしているため、ルートハンドラが
  // 実際に outcome.ambiguousGateIds を転送している保証にはならない。
  it('forwards ambiguousGateIds from the respond outcome to the decision response', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: projectA, ticketId: 'bdboard-a' }]);

    const respond = vi.fn<HumanDecisionsPort['respond']>(async () => ({
      kind: 'ticket',
      closed: false,
      ambiguousGateIds: ['bdboard-gate-1', 'bdboard-gate-2'],
    }));
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond,
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      outcome: {
        kind: 'ticket',
        closed: false,
        ambiguousGateIds: ['bdboard-gate-1', 'bdboard-gate-2'],
      },
    });
  });

  it('returns 400 when decision body has neither choice nor freeform', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };

    const app = createApiRoutes(createDeps({ humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'choice or freeform is required' });
  });

  it('returns 403 for decision POST through tunnel headers', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };

    const app = createApiRoutes(createDeps({ humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
  });

  it('returns 404 for decision POST when ticket is not in cache', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };

    const app = createApiRoutes(createDeps({ humanDecisions }));
    const response = await app.request(
      '/api/tickets/missing-ticket/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'ticket not found', id: 'missing-ticket' });
  });

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

  // ガード回帰テスト: isLocalControlRequest の呼び出し行を消すとこのテストが落ちる
  // (トンネル越しヘッダでも undo 系の書き込みが通ってしまうため)。
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

  it('returns 501 when dependency writer port is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'dependency editing not available' });
  });

  it('posts a local dependency add', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({ id: 'bdboard-a', projectId: proj.id }),
        makeTicket({ id: 'bdboard-b', projectId: proj.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(dependencyWriter.addDependency).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'bdboard-b',
    );
  });

  it('deletes a local blocks dependency', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: proj.id,
          dependencies: [
            {
              issueId: 'bdboard-a',
              dependsOnId: 'bdboard-b',
              kind: 'blocks',
            },
          ],
        }),
        makeTicket({ id: 'bdboard-b', projectId: proj.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies/bdboard-b',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(dependencyWriter.removeDependency).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'bdboard-b',
    );
  });

  it('returns 403 for dependency POST through tunnel headers', async () => {
    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies',
      withLocalHost({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
    expect(dependencyWriter.addDependency).not.toHaveBeenCalled();
  });

  it('returns 403 for dependency DELETE through tunnel headers', async () => {
    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies/bdboard-b',
      withLocalHost({
        method: 'DELETE',
        headers: {
          'CF-Ray': 'abc123',
        },
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
    expect(dependencyWriter.removeDependency).not.toHaveBeenCalled();
  });

  it('returns 502 with bd detail when dependency add fails', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({ id: 'bdboard-a', projectId: proj.id }),
        makeTicket({ id: 'bdboard-b', projectId: proj.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const circularDetail =
      'error: would create circular dependency: bdboard-a -> bdboard-b';
    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {
        throw new BdError('unknown', 'bdboard-a', circularDetail);
      }),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: 'failed to add dependency',
      detail: circularDetail,
    });
  });

  it('returns 400 when dependency target is in another project', async () => {
    const cache = createFakeBoardCache();
    const projA = project('proj-a', '/root/a');
    const projB = project('proj-b', '/root/b');
    cache.putProject({
      project: projA,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: projA.id })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: projB,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: projB.id })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'dependency target must be in the same project',
    });
    expect(dependencyWriter.addDependency).not.toHaveBeenCalled();
  });

  it('returns 400 when deleting a parent-child dependency', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: proj.id,
          dependencies: [
            {
              issueId: 'bdboard-a',
              dependsOnId: 'bdboard-parent',
              kind: 'parent-child',
            },
          ],
        }),
        makeTicket({ id: 'bdboard-parent', projectId: proj.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies/bdboard-parent',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'only blocks dependencies can be removed',
      kind: 'parent-child',
    });
    expect(dependencyWriter.removeDependency).not.toHaveBeenCalled();
  });

  it('returns 409 without calling bd when the edge is absent from the cache', async () => {
    // 削除ボタンはキャッシュ上の blocks エッジにしか出ない。キャッシュに無いものを
    // 消せてしまうと、stale な間に parent-child を消す事故が起こりうるので弾く。
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({ id: 'bdboard-a', projectId: proj.id, dependencies: [] }),
        makeTicket({ id: 'bdboard-b', projectId: proj.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies/bdboard-b',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'dependency not found on this ticket',
      id: 'bdboard-a',
      dependsOnId: 'bdboard-b',
    });
    expect(dependencyWriter.removeDependency).not.toHaveBeenCalled();
  });

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

  describe('POST /api/tickets/:id/session-link', () => {
    it('returns 501 when session link writer is not configured', async () => {
      const app = createApiRoutes(createDeps());
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(501);
      expect(body).toEqual({ error: 'session linking not available' });
    });

    it('links a session for a local request', async () => {
      const cache = createFakeBoardCache();
      seedCache(cache, [
        { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
      ]);

      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ cache, sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(sessionLinkWriter.linkSession).toHaveBeenCalledWith(
        '/root/a',
        'bdboard-a',
        'sess-1',
      );
    });

    it('returns 400 for an empty sessionId', async () => {
      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: '' }),
        }),
        LOCAL_ENV,
      );

      expect(response.status).toBe(400);
      expect(sessionLinkWriter.linkSession).not.toHaveBeenCalled();
    });

    it('returns 404 when the ticket is not found', async () => {
      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/missing-ticket/session-link',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        }),
        LOCAL_ENV,
      );

      expect(response.status).toBe(404);
      expect(sessionLinkWriter.linkSession).not.toHaveBeenCalled();
    });

    // Guards the isLocalControlRequest(c) gate at the top of the handler:
    // deleting that check would let this request through and call the writer.
    it('returns 403 for session-link POST through tunnel headers', async () => {
      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Ray': 'abc123',
          },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({ error: 'local access only' });
      expect(sessionLinkWriter.linkSession).not.toHaveBeenCalled();
    });

    it('returns 502 with bd detail when linking fails', async () => {
      const cache = createFakeBoardCache();
      seedCache(cache, [
        { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
      ]);

      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {
          throw new BdError('lock-contention', 'bdboard-a', 'database is locked');
        }),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ cache, sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(body).toEqual({
        error: 'failed to link session',
        detail: 'database is locked',
      });
    });
  });

  describe('DELETE /api/tickets/:id/session-link', () => {
    it('returns 501 when session link writer is not configured', async () => {
      const app = createApiRoutes(createDeps());
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({ method: 'DELETE' }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(501);
      expect(body).toEqual({ error: 'session linking not available' });
    });

    it('unlinks a session for a local request', async () => {
      const cache = createFakeBoardCache();
      seedCache(cache, [
        { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
      ]);

      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ cache, sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({ method: 'DELETE' }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(sessionLinkWriter.unlinkSession).toHaveBeenCalledWith(
        '/root/a',
        'bdboard-a',
      );
    });

    it('returns 404 when the ticket is not found', async () => {
      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/missing-ticket/session-link',
        withLocalHost({ method: 'DELETE' }),
        LOCAL_ENV,
      );

      expect(response.status).toBe(404);
      expect(sessionLinkWriter.unlinkSession).not.toHaveBeenCalled();
    });

    // Guards the isLocalControlRequest(c) gate at the top of the handler:
    // deleting that check would let this request through and call the writer.
    it('returns 403 for session-link DELETE through tunnel headers', async () => {
      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {}),
      };

      const app = createApiRoutes(createDeps({ sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({
          method: 'DELETE',
          headers: { 'CF-Ray': 'abc123' },
        }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({ error: 'local access only' });
      expect(sessionLinkWriter.unlinkSession).not.toHaveBeenCalled();
    });

    it('returns 502 with bd detail when unlinking fails', async () => {
      const cache = createFakeBoardCache();
      seedCache(cache, [
        { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
      ]);

      const sessionLinkWriter: SessionLinkWriterPort = {
        linkSession: vi.fn(async () => {}),
        unlinkSession: vi.fn(async () => {
          throw new BdError('unknown', 'bdboard-a', 'something went wrong');
        }),
      };

      const app = createApiRoutes(createDeps({ cache, sessionLinkWriter }));
      const response = await app.request(
        '/api/tickets/bdboard-a/session-link',
        withLocalHost({ method: 'DELETE' }),
        LOCAL_ENV,
      );
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(body).toEqual({
        error: 'failed to unlink session',
        detail: 'something went wrong',
      });
    });
  });
});

// bdboard-9rz: トンネル経由の「決定的な書き込み」開放。ガードは
// createApiRoutes 冒頭のミドルウェア 1 箇所に集約してあり、各ハンドラは
// もう自前のチェックを持たない。ここではその 1 箇所が期待どおりに開き / 閉じるかを
// 実ルート越しに固定する。トンネル経由の判別は既存テストと同じく
// CF-Ray ヘッダ + ループバック remoteAddress の擬似リクエストで行う。
describe('tunnel write access (bdboard-9rz)', () => {
  const CF_HEADER = { 'CF-Ray': 'abc123-NRT' } as const;
  const SESSION_COOKIE = 'bdboard_tunnel_session=example-session-value';

  function tunnelHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Cookie: SESSION_COOKIE,
      ...CF_HEADER,
      ...extra,
    };
  }

  function openWriteAccess(): ApiDeps['writeAccess'] {
    return {
      isTunnelWriteAllowed: () => true,
      hasTunnelSession: () => true,
    };
  }

  function makeIssueWriter(): IssueWriterPort {
    return {
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
  }

  function seededCache(): BoardCache {
    const cache = createFakeBoardCache();
    seedCache(cache, [
      { project: project('proj-a', '/root/a'), ticketId: 'bdboard-a' },
    ]);
    return cache;
  }

  // AC(1): quick-action / decision / コメント投稿がトンネル越しに通ること。
  it('allows a quick-action claim through the tunnel', async () => {
    const issueWriter = makeIssueWriter();
    const app = createApiRoutes(
      createDeps({
        cache: seededCache(),
        issueWriter,
        writeAccess: openWriteAccess(),
      }),
    );

    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(issueWriter.claim).toHaveBeenCalledWith('/root/a', 'bdboard-a');
  });

  it('allows an undefer quick-action through the tunnel', async () => {
    const issueWriter = makeIssueWriter();
    const app = createApiRoutes(
      createDeps({
        cache: seededCache(),
        issueWriter,
        writeAccess: openWriteAccess(),
      }),
    );

    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ action: 'undefer' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(issueWriter.undefer).toHaveBeenCalledWith('/root/a', 'bdboard-a');
  });

  it('allows a pending-decision response through the tunnel', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };
    const app = createApiRoutes(
      createDeps({
        cache: seededCache(),
        humanDecisions,
        writeAccess: openWriteAccess(),
      }),
    );

    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(humanDecisions.respond).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'yes',
    );
  });

  it('allows a comment through the tunnel', async () => {
    const issueWriter = makeIssueWriter();
    const app = createApiRoutes(
      createDeps({
        cache: seededCache(),
        issueWriter,
        writeAccess: openWriteAccess(),
      }),
    );

    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      withLocalHost({
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ text: 'from my phone' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(issueWriter.addComment).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'from my phone',
    );
  });

  // AC(3): 短いパスワードで起動したトンネルは読み取り専用のまま。
  it('keeps writes localhost-only when the tunnel password is too short', async () => {
    const issueWriter = makeIssueWriter();
    const app = createApiRoutes(
      createDeps({
        cache: seededCache(),
        issueWriter,
        writeAccess: {
          isTunnelWriteAllowed: () => false,
          hasTunnelSession: () => true,
        },
      }),
    );

    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'local access only' });
    expect(issueWriter.claim).not.toHaveBeenCalled();
  });

  it('rejects a tunnel write without a session cookie', async () => {
    const issueWriter = makeIssueWriter();
    const app = createApiRoutes(
      createDeps({
        cache: seededCache(),
        issueWriter,
        writeAccess: {
          isTunnelWriteAllowed: () => true,
          hasTunnelSession: () => false,
        },
      }),
    );

    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(403);
    expect(issueWriter.claim).not.toHaveBeenCalled();
  });

  // AC(5): 公開 URL に対する外部サイトからのクロスオリジン POST。
  it('rejects a cross-site write even with a fully valid tunnel session', async () => {
    const issueWriter = makeIssueWriter();
    const app = createApiRoutes(
      createDeps({
        cache: seededCache(),
        issueWriter,
        writeAccess: openWriteAccess(),
      }),
    );

    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: tunnelHeaders({ 'Sec-Fetch-Site': 'cross-site' }),
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'cross-site write blocked' });
    expect(issueWriter.claim).not.toHaveBeenCalled();
  });

  it('rejects a form-shaped cross-site POST from an attacker page', async () => {
    const issueWriter = makeIssueWriter();
    const app = createApiRoutes(
      createDeps({
        cache: seededCache(),
        issueWriter,
        writeAccess: openWriteAccess(),
      }),
    );

    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: SESSION_COOKIE,
          ...CF_HEADER,
        },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(403);
    expect(issueWriter.claim).not.toHaveBeenCalled();
  });

  // AC(4) の肝。tunnel-routes.test.ts の
  // 「guards tunnel sub-paths that no route handles yet」と同じ発想で、
  // ガードがルーティング解決より前に効いていること = まだハンドラの無い書き込み
  // エンドポイントも既定で守られることを固定する。ここが 404 になったら、
  // 「次に足されるエンドポイントが無防備で出荷される」状態に戻っている。
  it('guards write methods on paths that no route handles yet', async () => {
    const app = createApiRoutes(createDeps());

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await app.request(
        '/api/tickets/bdboard-a/not-implemented-yet',
        withLocalHost({
          method,
          headers: { 'Content-Type': 'application/json', ...CF_HEADER },
          body: method === 'DELETE' ? undefined : '{}',
        }),
        LOCAL_ENV,
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'local access only' });
    }
  });

  it('leaves reads reachable over the tunnel', async () => {
    const app = createApiRoutes(createDeps({ cache: seededCache() }));

    const response = await app.request(
      '/api/tickets/bdboard-a',
      withLocalHost({ headers: CF_HEADER }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
  });
});

describe('post-write project refresh (bdboard-6qs6)', () => {
  function seedProjectA() {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: projectA, ticketId: 'bdboard-a' }]);
    return { cache, projectA };
  }

  function makeIssueWriter(): IssueWriterPort {
    return {
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
  }

  it('calls refreshProjectByRootPath after successful decision POST', async () => {
    const { cache } = seedProjectA();
    const refreshProjectByRootPath = vi.fn(async () => {});
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };

    const app = createApiRoutes(
      createDeps({ cache, humanDecisions, refreshProjectByRootPath }),
    );
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(refreshProjectByRootPath).toHaveBeenCalledWith('/projects/a');
  });

  it('calls refreshProjectByRootPath after successful quick-action POST', async () => {
    const { cache } = seedProjectA();
    const refreshProjectByRootPath = vi.fn(async () => {});
    const issueWriter = makeIssueWriter();

    const app = createApiRoutes(
      createDeps({ cache, issueWriter, refreshProjectByRootPath }),
    );
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(refreshProjectByRootPath).toHaveBeenCalledWith('/projects/a');
  });

  it('calls refreshProjectByRootPath after successful comment POST', async () => {
    const { cache } = seedProjectA();
    const refreshProjectByRootPath = vi.fn(async () => {});
    const issueWriter = makeIssueWriter();

    const app = createApiRoutes(
      createDeps({ cache, issueWriter, refreshProjectByRootPath }),
    );
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'done' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(refreshProjectByRootPath).toHaveBeenCalledWith('/projects/a');
  });

  it('still returns 200 when refreshProjectByRootPath rejects after a successful write', async () => {
    const { cache } = seedProjectA();
    const refreshProjectByRootPath = vi.fn(async () => {
      throw new Error('refresh exploded');
    });
    const issueWriter = makeIssueWriter();

    const app = createApiRoutes(
      createDeps({ cache, issueWriter, refreshProjectByRootPath }),
    );
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'done' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(refreshProjectByRootPath).toHaveBeenCalledWith('/projects/a');
  });

  // このテストがバグ本体の回帰ガード。refreshProjectByRootPath を「呼ぶ」だけでは
  // 不十分で、応答を返す前に await していないと、UI が応答直後に再取得したときに
  // まだ書き込み前のキャッシュが返る(bdboard-6qs6)。fire-and-forget 実装は
  // 上の toHaveBeenCalledWith 系テストを素通りするので、ここで順序を固定する。
  it('does not respond until refreshProjectByRootPath settles', async () => {
    const { cache } = seedProjectA();
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshProjectByRootPath = vi.fn(async () => {
      await refreshGate;
    });
    const issueWriter = makeIssueWriter();

    const app = createApiRoutes(
      createDeps({ cache, issueWriter, refreshProjectByRootPath }),
    );

    let responded = false;
    const pending = Promise.resolve(
      app.request(
        '/api/tickets/bdboard-a/comment',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'done' }),
        }),
        LOCAL_ENV,
      ),
    ).then((response) => {
      responded = true;
      return response;
    });

    // マクロタスクを1回挟むと、保留中のマイクロタスクは全て流れる。それでも
    // 応答が返っていない = リフレッシュの完了を待っている。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshProjectByRootPath).toHaveBeenCalledWith('/projects/a');
    expect(responded).toBe(false);

    releaseRefresh?.();
    const response = await pending;

    expect(response.status).toBe(200);
  });

  it('does not call refreshProjectByRootPath when comment write fails', async () => {
    const { cache } = seedProjectA();
    const refreshProjectByRootPath = vi.fn(async () => {});
    const issueWriter = makeIssueWriter();
    issueWriter.addComment = vi.fn(async () => {
      throw new BdError('unknown', 'proj-a', 'bd failed');
    });

    const app = createApiRoutes(
      createDeps({ cache, issueWriter, refreshProjectByRootPath }),
    );
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'done' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(502);
    expect(refreshProjectByRootPath).not.toHaveBeenCalled();
  });
});
