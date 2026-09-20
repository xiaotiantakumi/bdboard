import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes, type ApiDeps } from './routes.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  type IssueWriterPort,
} from '../../application/ports/issue-writer.js';
import { LOCAL_ENV, withLocalHost, project, createFakeBoardCache, seedCache, createDeps } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
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
