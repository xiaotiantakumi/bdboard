import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { makeSession, makeSessionLink, makeTicket } from '../../domain/test-support.js';
import type { ProcessScanner } from '../../application/ports/process-scanner.js';
import type { SessionTailReader } from '../../application/ports/session-tail-reader.js';
import { NOW, project, createFakeBoardCache, seedCache, createDeps, assertNoDates } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns 501 when process scanner is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/processes');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'process scanner not available' });
  });
  it('returns detected agent processes from process scanner', async () => {
    const cache = createFakeBoardCache();
    cache.putProject({
      project: {
        id: 'proj-a',
        name: 'Alpha',
        rootPath: '/work/alpha',
        prefixes: ['bdboard'],
        aliasPaths: [],
      },
      tickets: [],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const processScanner: ProcessScanner = {
      listAgentProcesses: vi.fn(async () => [
        {
          pid: 42,
          command: 'claude',
          cwd: '/work/alpha/src',
          startedAt: new Date('2026-06-01T10:00:00.000Z'),
        },
      ]),
    };

    const app = createApiRoutes(createDeps({ cache, processScanner }));
    const response = await app.request('/api/processes');
    const body = await response.json();

    expect(response.status).toBe(200);
    assertNoDates(body);
    expect(body).toEqual([
      {
        pid: 42,
        command: 'claude',
        cwd: '/work/alpha/src',
        startedAt: '2026-06-01T10:00:00.000Z',
        projectId: 'proj-a',
        projectName: 'Alpha',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('--');
  });
  it('returns empty sessions when provider is absent', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/sessions');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([]);
  });
  it('returns sessions from deps.sessions provider', async () => {
    const session = makeSession({
      sessionId: 'session-a',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const app = createApiRoutes(
      createDeps({
        sessions: () => [session],
      }),
    );

    const response = await app.request('/api/sessions');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].sessionId).toBe('session-a');
    expect(body[0].alive).toBe(true);
    expect(body[0].liveness).toBe('active');
  });
  it('applies the configured liveness thresholds to sessions, projects and board', async () => {
    /*
     * bdboard-3tw.102.5: dto.ts が computeLiveness を閾値なしで呼んでいたため、
     * Settings で liveness 閾値を変えてもボードカードのバッジ (domain/board.ts
     * 経由なので正しかった) だけが追随し、ヘッダーの「稼働中 N」・セッション
     * 一覧・セッション詳細は既定値のまま、という食い違いが起きていた。
     * 4つのエンドポイントが同じ解決済み閾値を見ることを1本で押さえる。
     */
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    // 既定 (activeMs=5分) なら active、上書き (activeMs=1分) なら idle。
    const session = makeSession({
      sessionId: 'session-a',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: new Date(NOW.getTime() - 2 * 60_000),
    });

    const getBoardThresholds = vi.fn(async () => ({
      stalledThresholds: { stalledAfterMs: 60 * 60_000 },
      livenessThresholds: {
        activeMs: 60_000,
        idleMs: 10 * 60_000,
        staleMs: 60 * 60_000,
      },
    }));

    // カード内のセッション表示 (lanes[*].sessions[].liveness) も同じ閾値を見る。
    // ここを外すと、カードのバッジ (domain 経由) だけが新しい閾値に従い、その
    // 直下のセッション行が古い閾値のまま、というチケットそのものの症状に戻る。
    const links = [
      makeSessionLink({ sessionId: 'session-a', ticketId: 'bdboard-a' }),
    ];

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [session],
        links: () => links,
        getBoardThresholds,
      }),
    );

    const sessionsBody = await (await app.request('/api/sessions')).json();
    expect(sessionsBody[0].liveness).toBe('idle');

    const projectsBody = await (await app.request('/api/projects')).json();
    expect(projectsBody[0].activeSessionCount).toBe(0);
    expect(projectsBody[0].sessions[0].liveness).toBe('idle');

    /*
     * /api/sessions/history にも同じ閾値を通してあるが、ここでは検証していない。
     * getSessionHistory が返すのは alive === false のセッションだけで、
     * computeLiveness は !alive を即 'dormant' にするため、閾値が何であっても
     * 結果が変わらない (= 観測できない) ため。「ended だけ」の条件が将来外れた
     * ときに配線漏れを作らないよう、引数だけは他と同じ形で通してある。
     */

    const boardBody = await (
      await app.request('/api/board?view=split')
    ).json();
    expect(boardBody.projects[0].project.sessions[0].liveness).toBe('idle');
    expect(boardBody.projects[0].project.activeSessionCount).toBe(0);

    // カード側。バッジ (card.liveness、domain 由来) とカード内セッション行
    // (sessions[].liveness、DTO 由来) が同じ閾値を見ていることを1枚のカードで見る。
    const cards = Object.values(
      boardBody.projects[0].board.lanes as Record<string, unknown[]>,
    ).flat() as {
      ticket: { id: string };
      liveness: string;
      sessions: { liveness: string }[];
    }[];
    const card = cards.find((entry) => entry.ticket.id === 'bdboard-a');
    expect(card?.sessions).toHaveLength(1);
    expect(card?.sessions[0]?.liveness).toBe('idle');
    expect(card?.liveness).toBe('idle');

    // merged ビューのカードも同じ経路 (toBoardDto) を通る。
    const mergedBody = await (await app.request('/api/board')).json();
    const mergedCards = Object.values(
      mergedBody.merged.lanes as Record<string, unknown[]>,
    ).flat() as { sessions: { liveness: string }[] }[];
    expect(mergedCards[0]?.sessions[0]?.liveness).toBe('idle');

    // 設定を読まない実装に戻ると、この呼び出し自体が消える。
    expect(getBoardThresholds).toHaveBeenCalled();
  });
  it('returns session history for ended sessions only', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-linked',
          projectId: a.id,
          title: 'Linked ticket',
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const alive = makeSession({
      sessionId: 'session-alive',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
      name: 'Alive session',
    });
    const dead = makeSession({
      sessionId: 'session-dead',
      cwd: '/projects/a',
      alive: false,
      startedAt: new Date(NOW.getTime() - 3_600_000),
      lastActivityAt: NOW,
      name: 'Ended session',
    });
    const links = [
      makeSessionLink({
        sessionId: 'session-dead',
        ticketId: 'bdboard-linked',
      }),
    ];

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [alive, dead],
        links: () => links,
      }),
    );

    const response = await app.request('/api/sessions/history');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].session.sessionId).toBe('session-dead');
    expect(body[0].session.alive).toBe(false);
    expect(body[0].session.liveness).toBe('dormant');
    expect(body[0].projectId).toBe('/a');
    expect(body[0].projectName).toBe('/a');
    expect(body[0].tickets).toEqual([
      { ticketId: 'bdboard-linked', title: 'Linked ticket' },
    ]);
    assertNoDates(body);
  });
  it('returns empty session history when providers are absent', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/sessions/history');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([]);
  });
  it('clamps session history limit between 1 and 200 with default 50', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const sessions = Array.from({ length: 250 }, (_, index) =>
      makeSession({
        sessionId: `session-${index}`,
        cwd: '/projects/a',
        alive: false,
        startedAt: NOW,
        lastActivityAt: new Date(NOW.getTime() - index * 60_000),
      }),
    );

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => sessions,
      }),
    );

    const overLimit = await app.request('/api/sessions/history?limit=999');
    expect(overLimit.status).toBe(200);
    expect((await overLimit.json()) as unknown[]).toHaveLength(200);

    const underLimit = await app.request('/api/sessions/history?limit=0');
    expect(underLimit.status).toBe(200);
    expect((await underLimit.json()) as unknown[]).toHaveLength(1);

    const defaultLimit = await app.request('/api/sessions/history');
    expect(defaultLimit.status).toBe(200);
    expect((await defaultLimit.json()) as unknown[]).toHaveLength(50);

    const invalidLimit = await app.request('/api/sessions/history?limit=abc');
    expect(invalidLimit.status).toBe(200);
    expect((await invalidLimit.json()) as unknown[]).toHaveLength(50);
  });
  it('filters session history using the shared projects query parameter', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    for (const proj of [a, b]) {
      cache.putProject({
        project: proj,
        tickets: [],
        fingerprint: `fp-${proj.id}`,
        fetchedAt: NOW,
      });
    }
    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [
          makeSession({
            sessionId: 'session-a',
            cwd: '/projects/a',
            alive: false,
            lastActivityAt: NOW,
          }),
          makeSession({
            sessionId: 'session-b',
            cwd: '/projects/b',
            alive: false,
            lastActivityAt: NOW,
          }),
        ],
      }),
    );

    const response = await app.request('/api/sessions/history?projects=%2Fa');

    expect(response.status).toBe(200);
    expect(
      (await response.json()).map(
        (entry: { session: { sessionId: string } }) => entry.session.sessionId,
      ),
    ).toEqual(['session-a']);
  });
  it('keeps GET /api/sessions working alongside session history route', async () => {
    const session = makeSession({
      sessionId: 'session-live',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const app = createApiRoutes(
      createDeps({
        sessions: () => [session],
      }),
    );

    const sessionsResponse = await app.request('/api/sessions');
    const sessionsBody = await sessionsResponse.json();

    expect(sessionsResponse.status).toBe(200);
    expect(sessionsBody).toHaveLength(1);
    expect(sessionsBody[0].sessionId).toBe('session-live');

    const historyResponse = await app.request('/api/sessions/history');
    expect(historyResponse.status).toBe(200);
    expect(await historyResponse.json()).toEqual([]);
  });
  it('returns 501 when session tail reader is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/sessions/session-1/tail');

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: 'session tail reader not available',
    });
  });
  it('returns 404 for unknown session id on tail route', async () => {
    const sessionTail: SessionTailReader = {
      readTail: vi.fn(async () => []),
    };
    const app = createApiRoutes(createDeps({ sessionTail }));

    const response = await app.request('/api/sessions/missing-session/tail');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'session not found' });
  });
  it('returns 404 when session cwd is outside tracked projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const session = makeSession({
      sessionId: 'session-outside',
      cwd: '/outside/project',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const sessionTail: SessionTailReader = {
      readTail: vi.fn(async () => [{ role: 'user' as const, text: 'hidden' }]),
    };

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [session],
        sessionTail,
      }),
    );

    const response = await app.request('/api/sessions/session-outside/tail');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'session not found' });
    expect(sessionTail.readTail).not.toHaveBeenCalled();
  });
  it('returns session tail messages when session and transcript exist', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const session = makeSession({
      sessionId: 'session-live',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const readTail = vi.fn(async () => [
      {
        role: 'user' as const,
        text: 'hello',
        timestamp: '2026-06-20T11:03:56.949Z',
      },
      { role: 'assistant' as const, text: 'hi' },
    ]);
    const sessionTail: SessionTailReader = { readTail };

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [session],
        sessionTail,
      }),
    );

    const response = await app.request('/api/sessions/session-live/tail');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      sessionId: 'session-live',
      messages: [
        {
          role: 'user',
          text: 'hello',
          timestamp: '2026-06-20T11:03:56.949Z',
        },
        { role: 'assistant', text: 'hi' },
      ],
    });
    expect(readTail).toHaveBeenCalledWith(session, 50);
    assertNoDates(body);
  });
  it('returns 404 when transcript file is missing', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const session = makeSession({
      sessionId: 'session-no-transcript',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const sessionTail: SessionTailReader = {
      readTail: vi.fn(async () => undefined),
    };

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [session],
        sessionTail,
      }),
    );

    const response = await app.request('/api/sessions/session-no-transcript/tail');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'transcript not found' });
  });
  it('clamps session tail lines between 1 and 200 with default 50', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const session = makeSession({
      sessionId: 'session-limit',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const readTail = vi.fn(async (_session, limit: number) => {
      return Array.from({ length: limit }, (_, index) => ({
        role: 'user' as const,
        text: `msg-${index}`,
      }));
    });
    const sessionTail: SessionTailReader = { readTail };

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [session],
        sessionTail,
      }),
    );

    const overLimit = await app.request('/api/sessions/session-limit/tail?lines=999');
    expect(overLimit.status).toBe(200);
    expect((await overLimit.json()).messages).toHaveLength(200);
    expect(readTail).toHaveBeenLastCalledWith(session, 200);

    const underLimit = await app.request('/api/sessions/session-limit/tail?lines=0');
    expect(underLimit.status).toBe(200);
    expect((await underLimit.json()).messages).toHaveLength(1);
    expect(readTail).toHaveBeenLastCalledWith(session, 1);

    const defaultLimit = await app.request('/api/sessions/session-limit/tail');
    expect(defaultLimit.status).toBe(200);
    expect((await defaultLimit.json()).messages).toHaveLength(50);
    expect(readTail).toHaveBeenLastCalledWith(session, 50);

    const invalidLimit = await app.request('/api/sessions/session-limit/tail?lines=abc');
    expect(invalidLimit.status).toBe(200);
    expect((await invalidLimit.json()).messages).toHaveLength(50);
    expect(readTail).toHaveBeenLastCalledWith(session, 50);
  });
});
