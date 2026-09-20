import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes, type ApiDeps } from './routes.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import { makeSession, makeSessionLink, makeTicket } from '../../domain/test-support.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import type { DependencyWriterPort } from '../../application/ports/dependency-writer.js';
import type { SessionLinkWriterPort } from '../../application/ports/session-link-writer.js';
import type { LeaseReader } from '../../application/ports/lease-reader.js';
import type { MergeSlotReader } from '../../application/ports/merge-slot-reader.js';
import type { PrStatus } from '../../domain/pr-link.js';
import type { PrStatusReader } from '../../application/ports/pr-status-reader.js';
import type { ReclaimScheduler } from '../../application/lease/reclaim-scheduler.js';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  ContentConflictError,
  PriorityConflictError,
  StatusConflictError,
  type IssueWriterPort,
} from '../../application/ports/issue-writer.js';
import { NOW, LOCAL_ENV, withLocalHost, project, createFakeBoardCache, seedCache, createDeps, assertNoDates, inFlightScanner, inFlightCache, IN_FLIGHT_FILES } from './routes-test-support.js';



describe('createApiRoutes', () => {

  it('returns dependency graph filtered by projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: a.id,
          dependencies: [
            { issueId: 'bdboard-a', dependsOnId: 'bdboard-b', kind: 'blocks' },
          ],
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, dependencies: [] })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request(`/api/graph?projects=${encodeURIComponent(a.id)}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeNull();
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    assertNoDates(body);
  });

  it('returns dependency graph nodes and edges across projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: a.id,
          dependencies: [
            { issueId: 'bdboard-a', dependsOnId: 'bdboard-b', kind: 'blocks' },
          ],
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, dependencies: [] })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/graph');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toEqual([
      { from: 'bdboard-a', to: 'bdboard-b', kind: 'blocks' },
    ]);
    expect(body.nodes[0]).toMatchObject({
      ticketId: expect.any(String),
      projectId: expect.any(String),
      title: expect.any(String),
      status: expect.any(String),
      priority: expect.any(Number),
      issueType: expect.any(String),
      layer: expect.any(Number),
    });
    assertNoDates(body);
  });

  it('returns ticket detail for dot-containing id', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-3tw.10' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/bdboard-3tw.10');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.id).toBe('bdboard-3tw.10');
  });

  it('builds the direct children list (id/title/lane) for ticket detail, excluding grandchildren (bdboard-3tw.95)', async () => {
    // Exercises the children-index construction in the route handler itself
    // (buildDirectChildrenIndex over view.merged.cards + cardsById lookup),
    // not just the toTicketDetailDto passthrough covered in dto.test.ts.
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-epic', projectId: a.id, title: 'Epic' }),
        makeTicket({
          id: 'bdboard-child-open',
          projectId: a.id,
          parentId: 'bdboard-epic',
          title: 'Open child',
        }),
        makeTicket({
          id: 'bdboard-child-done',
          projectId: a.id,
          parentId: 'bdboard-epic',
          title: 'Done child',
          status: 'closed',
        }),
        makeTicket({
          id: 'bdboard-grandchild',
          projectId: a.id,
          parentId: 'bdboard-child-open',
          title: 'Grandchild',
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/bdboard-epic');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.children).toHaveLength(2);
    expect(body.children).toEqual(
      expect.arrayContaining([
        { id: 'bdboard-child-open', title: 'Open child', lane: 'ready' },
        { id: 'bdboard-child-done', title: 'Done child', lane: 'done' },
      ]),
    );
    expect(
      (body.children as { id: string }[]).map((child) => child.id),
    ).not.toContain('bdboard-grandchild');
  });

  it('includes token usage when links and cache usage exist', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-3tw.10' }]);
    cache.getSessionUsage = () => [
      {
        model: 'claude-opus-5',
        inputTokens: 12,
        outputTokens: 6,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 50,
      },
    ];

    const links = () => [
      {
        ticketId: 'bdboard-3tw.10',
        sessionId: 'sess-a',
        source: 'transcript' as const,
        confidence: 0.6,
        observedAt: NOW,
      },
    ];

    const app = createApiRoutes(createDeps({ cache, links }));
    const response = await app.request('/api/tickets/bdboard-3tw.10');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.usage).toEqual({
      totalInputTokens: 12,
      totalOutputTokens: 6,
      totalCacheCreationInputTokens: 100,
      totalCacheReadInputTokens: 50,
      byModel: [
        {
          model: 'claude-opus-5',
          inputTokens: 12,
          outputTokens: 6,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 50,
        },
      ],
    });
  });

  it('still finds a closed ticket older than /api/board default closedLimit (bdboard-3tw.86)', async () => {
    // /api/board のclosedLimit(既定100件/プロジェクト)は表示用の一覧を絞るだけで、
    // IDでの直接取得(/api/tickets/:id)には効かせない設計であることの回帰確認。
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const closedTickets = Array.from({ length: 120 }, (_, i) =>
      makeTicket({
        id: `bdboard-closed-${i}`,
        projectId: a.id,
        status: 'closed',
        closedAt: new Date(NOW.getTime() - i * 60_000),
      }),
    );
    cache.putProject({
      project: a,
      tickets: closedTickets,
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));

    // bdboard-closed-119 is the oldest -> falls outside the top-100 by closedAt desc
    const boardResponse = await app.request('/api/board');
    const boardBody = await boardResponse.json();
    expect(
      boardBody.merged.lanes.done.some(
        (c: { ticket: { id: string } }) => c.ticket.id === 'bdboard-closed-119',
      ),
    ).toBe(false);

    const detailResponse = await app.request('/api/tickets/bdboard-closed-119');
    const detailBody = await detailResponse.json();
    expect(detailResponse.status).toBe(200);
    expect(detailBody.id).toBe('bdboard-closed-119');
  });

  it('returns 404 for missing ticket', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/tickets/missing-ticket');
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'ticket not found', id: 'missing-ticket' });
  });

  it('returns ticket timeline events for a cached ticket id', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');
    const startedAt = new Date('2026-06-01T09:00:00.000Z');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: { ...a, name: 'Alpha Project' },
      tickets: [
        makeTicket({
          id: 'bdboard-timeline',
          projectId: a.id,
          title: 'Timeline ticket',
          createdAt,
          startedAt,
          closedAt,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/bdboard-timeline/timeline');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(3);
    expect(body[0]).toEqual({
      kind: 'closed',
      at: closedAt.toISOString(),
      id: 'bdboard-timeline',
      projectId: a.id,
      projectName: 'Alpha Project',
      title: 'Timeline ticket',
      status: 'open',
      priority: 2,
      issueType: 'task',
    });
    assertNoDates(body);
  });

  it('returns an empty array for ticket timeline when ticket is missing', async () => {
    const cache = createFakeBoardCache();
    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/missing-ticket/timeline');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('returns similar tickets sorted by score for a cached ticket id', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const target = makeTicket({
      id: 'bdboard-target',
      projectId: a.id,
      title: 'Similar ticket detection',
      description: 'Show similar tickets in the detail panel',
    });
    const high = makeTicket({
      id: 'bdboard-high',
      projectId: a.id,
      title: 'Similar ticket detection',
      description: 'Show similar tickets in the detail panel',
    });
    const medium = makeTicket({
      id: 'bdboard-medium',
      projectId: b.id,
      title: 'Similar ticket panel',
      description: 'Show similar tickets in the detail panel',
    });
    const unrelated = makeTicket({
      id: 'bdboard-unrelated',
      projectId: b.id,
      title: 'Mobile tunnel QR code',
      description: 'Fix Safari credential URL handling',
    });

    cache.putProject({
      project: { ...a, name: 'Alpha Project' },
      tickets: [target, high],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: { ...b, name: 'Beta Project' },
      tickets: [medium, unrelated],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/bdboard-target/similar');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      id: 'bdboard-high',
      projectId: a.id,
      projectName: 'Alpha Project',
      title: 'Similar ticket detection',
      status: 'open',
      priority: 2,
      issueType: 'task',
      score: 1,
    });
    expect(body[1].id).toBe('bdboard-medium');
    expect(body[1].score).toBeGreaterThan(0);
    expect(body.some((entry: { id: string }) => entry.id === 'bdboard-target')).toBe(false);
    expect(body.some((entry: { id: string }) => entry.id === 'bdboard-unrelated')).toBe(false);
    assertNoDates(body);
  });

  it('returns an empty array for similar tickets when ticket is missing', async () => {
    const cache = createFakeBoardCache();
    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/missing-ticket/similar');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('clamps similar ticket limit between 1 and 20', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const target = makeTicket({
      id: 'bdboard-target',
      projectId: a.id,
      title: 'Similar ticket detection',
      description: 'Detail panel display',
    });
    const similarTickets = Array.from({ length: 25 }, (_, index) =>
      makeTicket({
        id: `bdboard-similar-${index}`,
        projectId: a.id,
        title: 'Similar ticket detection',
        description: 'Detail panel display',
      }),
    );

    cache.putProject({
      project: a,
      tickets: [target, ...similarTickets],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));

    const over = await app.request('/api/tickets/bdboard-target/similar?limit=100');
    expect(over.status).toBe(200);
    expect((await over.json()) as unknown[]).toHaveLength(20);

    const under = await app.request('/api/tickets/bdboard-target/similar?limit=0');
    expect(under.status).toBe(200);
    expect((await under.json()) as unknown[]).toHaveLength(1);

    const defaultLimit = await app.request('/api/tickets/bdboard-target/similar');
    expect(defaultLimit.status).toBe(200);
    expect((await defaultLimit.json()) as unknown[]).toHaveLength(5);
  });

  it('returns hygiene issues filtered by projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-overdue',
          projectId: a.id,
          status: 'deferred',
          deferUntil: new Date(NOW.getTime() - 60_000),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-missing',
          projectId: b.id,
          priority: undefined as never,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request(`/api/hygiene?projects=${encodeURIComponent(a.id)}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeNull();
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({
      kind: 'overdue_defer',
      ticketId: 'bdboard-overdue',
      projectId: a.id,
      severity: 'warning',
    });
    expect(body.closeEvidence).toBeNull();
    assertNoDates(body);
  });

  it('lets a recent comment keep a pending decision out of the hygiene list', async () => {
    // bdboard-19db: bd の updated_at はコメントで動かないので、ルートが
    // getPendingCommentAnchors を通していないと、コメントで議論が続いている
    // チケットまで「放置された確認待ち」に出る。ここは配線の確認。
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const stale = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000);
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-chatty',
          projectId: a.id,
          updatedAt: stale,
          commentCount: 2,
        }),
        makeTicket({
          id: 'bdboard-silent',
          projectId: a.id,
          updatedAt: stale,
          commentCount: 0,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
      pendingDecisions: [
        { id: 'bdboard-chatty', kind: 'ticket', allowFreeform: true },
        { id: 'bdboard-silent', kind: 'ticket', allowFreeform: true },
      ],
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_root: string, issueId: string) => [
        {
          id: `${issueId}-1`,
          issueId,
          author: 'someone',
          text: 'まだ話している',
          createdAt: new Date(NOW.getTime() - 60_000),
        },
      ]),
    };

    const app = createApiRoutes(createDeps({ cache, commentReader }));
    const response = await app.request('/api/hygiene');
    const body = await response.json();

    expect(response.status).toBe(200);
    const pending = body.issues.filter(
      (issue: { kind: string }) => issue.kind === 'stale_pending_decision',
    );
    // コメントの無いほうだけが残る。
    expect(pending.map((issue: { ticketId: string }) => issue.ticketId)).toEqual([
      'bdboard-silent',
    ]);
    // commentCount が 0 のチケットには bd を叩かない。
    expect(commentReader.listComments).toHaveBeenCalledTimes(1);
  });

  it('does not fetch comments for projects outside the requested filter', async () => {
    // bdboard-19db: bd 呼び出しは1件あたり秒単位なので、絞り込み外のプロジェクトまで
    // 引くと素通しの分だけ /api/hygiene が遅くなる。ルートが projectIds を
    // getPendingCommentAnchors へ渡していることの確認。
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const stale = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000);
    for (const p of [a, b]) {
      cache.putProject({
        project: p,
        tickets: [
          makeTicket({
            id: `bdboard-chatty-${p.id}`,
            projectId: p.id,
            updatedAt: stale,
            commentCount: 1,
          }),
        ],
        fingerprint: `fp${p.id}`,
        fetchedAt: NOW,
        pendingDecisions: [{ id: `bdboard-chatty-${p.id}`, kind: 'ticket', allowFreeform: true }],
      });
    }

    const roots: string[] = [];
    const commentReader: CommentReader = {
      listComments: vi.fn(async (rootPath: string, issueId: string) => {
        roots.push(rootPath);
        return [
          {
            id: `${issueId}-1`,
            issueId,
            author: 'someone',
            text: 'まだ話している',
            createdAt: new Date(NOW.getTime() - 60_000),
          },
        ];
      }),
    };

    const app = createApiRoutes(createDeps({ cache, commentReader }));
    const response = await app.request(
      `/api/hygiene?projects=${encodeURIComponent(a.id)}`,
    );

    expect(response.status).toBe(200);
    expect(roots).toEqual([a.rootPath]);
  });

  it('still reports stale pending decisions when no commentReader is wired', async () => {
    // commentReader は任意依存。無い構成で検知ごと消えると、コメントを見る変更が
    // 「検知を静かに殺す」変更になってしまう。
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-chatty',
          projectId: a.id,
          updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
          commentCount: 2,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
      pendingDecisions: [{ id: 'bdboard-chatty', kind: 'ticket', allowFreeform: true }],
    });

    const app = createApiRoutes(createDeps({ cache }));
    const body = await (await app.request('/api/hygiene')).json();

    expect(
      body.issues.map((issue: { kind: string }) => issue.kind),
    ).toContain('stale_pending_decision');
    expect(body.closeEvidence).toBeNull();
  });

  it('reuses the PR-badge comment scan for /api/hygiene and does not call listComments again', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const closedAt = new Date(NOW.getTime() - 60_000);
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-closed',
          projectId: a.id,
          status: 'closed',
          closedAt,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_root: string, issueId: string) => [
        {
          id: `${issueId}-1`,
          issueId,
          author: 'someone',
          text: 'PR: https://github.com/x/y/pull/99',
          createdAt: new Date(NOW.getTime() - 30_000),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    const app = createApiRoutes(
      createDeps({ cache, commentReader, prStatusReader }),
    );

    const prLinks = await app.request('/api/pr-links');
    expect(prLinks.status).toBe(200);
    expect(commentReader.listComments).toHaveBeenCalledTimes(1);

    const hygiene = await app.request('/api/hygiene');
    expect(hygiene.status).toBe(200);
    expect(commentReader.listComments).toHaveBeenCalledTimes(1);

    const hygieneAgain = await app.request('/api/hygiene');
    expect(hygieneAgain.status).toBe(200);
    expect(commentReader.listComments).toHaveBeenCalledTimes(1);
  });

  it('flags closed_without_evidence once the PR-badge scan has covered the ticket, with unknownCount 0', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: a.id,
          status: 'closed',
          closedAt: new Date(NOW.getTime() - 60_000),
          commentCount: 1,
        }),
        makeTicket({
          id: 'bdboard-b',
          projectId: a.id,
          status: 'closed',
          closedAt: new Date(NOW.getTime() - 120_000),
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_root: string, issueId: string) => [
        {
          id: `${issueId}-1`,
          issueId,
          author: 'someone',
          text: 'close しました',
          createdAt: new Date(NOW.getTime() - 30_000),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    const app = createApiRoutes(
      createDeps({ cache, commentReader, prStatusReader }),
    );

    // PR バッジ用スキャン (/api/pr-links) で両チケットとも「証拠なし」を
    // 確定させておく。これが無いと hygiene 側は unknown のままになる
    // (bdboard-pkr6.16, M3: この配線が抜けても検知できるようにするテスト)。
    const prLinks = await app.request('/api/pr-links');
    expect(prLinks.status).toBe(200);

    const body = await (await app.request('/api/hygiene')).json();

    expect(body.closeEvidence).toEqual({ unknownCount: 0 });
    const closedWithoutEvidenceTicketIds = body.issues
      .filter((issue: { kind: string }) => issue.kind === 'closed_without_evidence')
      .map((issue: { ticketId: string }) => issue.ticketId);
    expect(closedWithoutEvidenceTicketIds.sort()).toEqual(['bdboard-a', 'bdboard-b']);
  });

  it('does not flag closed_without_evidence without commentReader and returns closeEvidence null', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-no-evidence',
          projectId: a.id,
          status: 'closed',
          closedAt: new Date(NOW.getTime() - 60_000),
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const body = await (await app.request('/api/hygiene')).json();

    expect(body.closeEvidence).toBeNull();
    expect(
      body.issues.filter(
        (issue: { kind: string }) => issue.kind === 'closed_without_evidence',
      ),
    ).toEqual([]);
  });

  it('returns merged_leftover hygiene issues with cleanup when worktreeScanner is configured', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-merged',
          projectId: a.id,
          status: 'closed',
          closedAt: NOW,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const worktreeScanner: WorktreeScanner = {
      listChangedFiles: async () => [],
      scan: vi.fn(async () => ({
        worktrees: [
          { path: '/projects/a', branch: 'main', isMain: true },
          {
            path: '/projects/a/.claude/worktrees/bdboard-merged',
            branch: 'bd/bdboard-merged',
            isMain: false,
          },
        ],
        bdBranches: ['bd/bdboard-merged'],
        complete: true,
      })),
    };

    const app = createApiRoutes(createDeps({ cache, worktreeScanner }));
    const response = await app.request('/api/hygiene');
    const body = await response.json();

    expect(response.status).toBe(200);
    const leftovers = body.issues.filter(
      (issue: { kind: string }) => issue.kind === 'merged_leftover',
    );
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatchObject({
      kind: 'merged_leftover',
      ticketId: 'bdboard-merged',
      projectId: a.id,
      severity: 'warning',
      cleanup: {
        repoRootPath: '/projects/a',
        worktreePath: '/projects/a/.claude/worktrees/bdboard-merged',
        branchName: 'bd/bdboard-merged',
      },
    });
    assertNoDates(body);
  });

  it('returns in_flight_file_overlap hygiene issues for both sides of a pair', async () => {
    const { cache, projectId } = inFlightCache();
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: inFlightScanner(IN_FLIGHT_FILES) }),
    );

    const response = await app.request('/api/hygiene');
    const body = await response.json();

    expect(response.status).toBe(200);
    const overlaps = body.issues.filter(
      (issue: { kind: string }) => issue.kind === 'in_flight_file_overlap',
    );
    expect(overlaps).toHaveLength(2);
    expect(overlaps[0]).toMatchObject({
      ticketId: 'bdboard-x',
      projectId,
      severity: 'info',
      overlaps: [{ otherTicketId: 'bdboard-y', files: ['src/domain/hygiene.ts'] }],
    });
    expect(overlaps[1]).toMatchObject({
      ticketId: 'bdboard-y',
      overlaps: [{ otherTicketId: 'bdboard-x', files: ['src/domain/hygiene.ts'] }],
    });
    assertNoDates(body);
  });

  it('uses the contract mainBranch only for worktrees measured by hygiene', async () => {
    const { cache, projectId } = inFlightCache();
    const getProjectMainBranch = vi.fn(async () => 'master');
    const countHarnessCommitsBehindDefaultBranch = vi.fn(async (_path, options) => ({
      commitsBehind: 5,
      baseRef: `origin/${options?.mainBranch}`,
    }));
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const app = createApiRoutes(
      createDeps({
        cache,
        worktreeScanner: { ...base, countHarnessCommitsBehindDefaultBranch },
        getProjectMainBranch,
      }),
    );

    const body = await (await app.request('/api/hygiene')).json();

    expect(getProjectMainBranch).toHaveBeenCalledTimes(1);
    expect(getProjectMainBranch).toHaveBeenCalledWith('/projects/a');
    expect(countHarnessCommitsBehindDefaultBranch).toHaveBeenCalledWith(
      '/projects/a/.claude/worktrees/bdboard-x',
      { mainBranch: 'master' },
    );
    expect(body.issues).toContainEqual(expect.objectContaining({
      kind: 'stale_harness_worktree',
      projectId,
      message: expect.stringContaining('origin/master'),
    }));
  });

  it('does not read the contract when the scanner cannot measure harness lag', async () => {
    const { cache } = inFlightCache();
    const getProjectMainBranch = vi.fn(async () => 'master');
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const withoutLag: WorktreeScanner = {
      scan: base.scan,
      listChangedFiles: base.listChangedFiles,
    };
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: withoutLag, getProjectMainBranch }),
    );

    const response = await app.request('/api/hygiene');

    expect(response.status).toBe(200);
    expect(getProjectMainBranch).not.toHaveBeenCalled();
  });

  it('falls back without failing hygiene when the contract mainBranch cannot be read', async () => {
    const { cache } = inFlightCache();
    const countHarnessCommitsBehindDefaultBranch = vi.fn(async (_path, options) => ({
      commitsBehind: 5,
      baseRef: options?.mainBranch === undefined ? 'origin/main' : 'origin/master',
    }));
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const app = createApiRoutes(
      createDeps({
        cache,
        worktreeScanner: { ...base, countHarnessCommitsBehindDefaultBranch },
        getProjectMainBranch: async () => {
          throw new Error('contract unavailable');
        },
      }),
    );

    const response = await app.request('/api/hygiene');

    expect(response.status).toBe(200);
    expect(countHarnessCommitsBehindDefaultBranch).toHaveBeenCalledWith(
      '/projects/a/.claude/worktrees/bdboard-x',
      { mainBranch: undefined },
    );
  });

  // bdboard-wadg: bd/ に紐づかない worktree (feature/* 等) は HygieneIssue の形に乗らない
  // ため、/api/hygiene のチケット issues とは別に nonTicketHarnessWorktrees で返す。
  // bdboard-cjsa: このレーンは生存セッション (cwd がその worktree の内側にある alive な
  // セッション) がある worktree だけを対象にするので、ここでは cwd の合う生存セッションを
  // 明示的に用意する。
  it('reports stale harness for non-ticket (feature/*) worktrees separately from issues', async () => {
    const { cache } = inFlightCache();
    const getProjectMainBranch = vi.fn(async () => 'master');
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const scanWithFeatureWorktree: WorktreeScanner = {
      ...base,
      scan: async (rootPath) => {
        const snapshot = await base.scan(rootPath);
        return {
          ...snapshot,
          worktrees: [
            ...snapshot.worktrees,
            {
              path: '/projects/a/.claude/worktrees/mac-slow-diagnosis-7ddee1',
              branch: 'feature/mac-slow-diagnosis-7ddee1',
              isMain: false,
            },
          ],
        };
      },
      countHarnessCommitsBehindDefaultBranch: async (_path, options) => ({
        commitsBehind: 63,
        baseRef: `origin/${options?.mainBranch ?? 'main'}`,
      }),
    };
    const session = makeSession({
      cwd: '/projects/a/.claude/worktrees/mac-slow-diagnosis-7ddee1',
      alive: true,
    });
    const app = createApiRoutes(
      createDeps({
        cache,
        worktreeScanner: scanWithFeatureWorktree,
        getProjectMainBranch,
        sessions: () => [session],
      }),
    );

    const body = await (await app.request('/api/hygiene')).json();

    expect(body.nonTicketHarnessWorktrees).toContainEqual({
      projectId: 'proj-a',
      worktreePath: '/projects/a/.claude/worktrees/mac-slow-diagnosis-7ddee1',
      branchName: 'feature/mac-slow-diagnosis-7ddee1',
      commitsBehind: 63,
      baseRef: 'origin/master',
      message: expect.stringContaining('feature/mac-slow-diagnosis-7ddee1'),
    });
    // チケット単位の issues 側に stale_harness_worktree が出ること自体は妨げない
    // (このテストの IN_FLIGHT_FILES には in_progress チケットの bd/ worktree があるため、
    // それらは正当に stale_harness_worktree としても検出される)。ここで確認したいのは、
    // feature/* worktree 自体がどちらか一方にしか出ないこと ―― ticketId を持たないので
    // issues 側には一切現れず、その worktree パスへの言及も issues 側のどのメッセージにも
    // 無いことを、パス文字列で厳密にチェックする。
    const staleHarnessIssues = body.issues.filter(
      (issue: { kind: string }) => issue.kind === 'stale_harness_worktree',
    );
    expect(
      staleHarnessIssues.every((issue: { ticketId: string }) =>
        ['bdboard-x', 'bdboard-y', 'bdboard-z'].includes(issue.ticketId),
      ),
    ).toBe(true);
    expect(
      body.issues.some((issue: { message?: string }) =>
        issue.message?.includes(
          '/projects/a/.claude/worktrees/mac-slow-diagnosis-7ddee1',
        ),
      ),
    ).toBe(false);
  });

  // bdboard-cjsa レビュー指摘: 元のこのテストは non-ticket worktree を snapshot に
  // 一切含めていなかったため、結果が空になる理由が「scanner が測れない」なのか
  // 「そもそも non-ticket worktree が無い」なのか区別できていなかった。feature/*
  // worktree と生存セッションを足し、gate は通るが scanner 側が測れない、という
  // ケースを明示的に作る。
  it('returns an empty nonTicketHarnessWorktrees array when the scanner cannot measure lag', async () => {
    const { cache } = inFlightCache();
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const withoutLag: WorktreeScanner = {
      scan: async (rootPath) => {
        const snapshot = await base.scan(rootPath);
        return {
          ...snapshot,
          worktrees: [
            ...snapshot.worktrees,
            {
              path: '/projects/a/.claude/worktrees/mac-slow-diagnosis-7ddee1',
              branch: 'feature/mac-slow-diagnosis-7ddee1',
              isMain: false,
            },
          ],
        };
      },
      listChangedFiles: base.listChangedFiles,
      // countHarnessCommitsBehindDefaultBranch を意図的に持たせない
      // (scanNonTicketHarnessWorktreeLags / scanHarnessWorktreeLags 双方の早期 return を突く)。
    };
    const session = makeSession({
      cwd: '/projects/a/.claude/worktrees/mac-slow-diagnosis-7ddee1',
      alive: true,
    });
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: withoutLag, sessions: () => [session] }),
    );

    const body = await (await app.request('/api/hygiene')).json();

    expect(body.nonTicketHarnessWorktrees).toEqual([]);
  });

  // bdboard-cjsa 本題: 生存セッションのゲーティング。セッションが無い/死んでいる/cwd が
  // 別の worktree を指している場合は、放棄済みとみなして警告からもコミット遅れ計測からも
  // 除外する。
  it('omits a non-ticket worktree with no live session, and never measures it', async () => {
    const { cache } = inFlightCache();
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const countHarnessCommitsBehindDefaultBranch = vi.fn(async (_path, options) => ({
      commitsBehind: 63,
      baseRef: `origin/${options?.mainBranch ?? 'main'}`,
    }));
    const scanWithFeatureWorktree: WorktreeScanner = {
      ...base,
      scan: async (rootPath) => {
        const snapshot = await base.scan(rootPath);
        return {
          ...snapshot,
          worktrees: [
            ...snapshot.worktrees,
            {
              path: '/projects/a/.claude/worktrees/mac-slow-diagnosis-7ddee1',
              branch: 'feature/mac-slow-diagnosis-7ddee1',
              isMain: false,
            },
          ],
        };
      },
      countHarnessCommitsBehindDefaultBranch,
    };
    const deadSession = makeSession({
      cwd: '/projects/a/.claude/worktrees/mac-slow-diagnosis-7ddee1',
      alive: false,
    });
    const elsewhereSession = makeSession({
      cwd: '/projects/a/.claude/worktrees/some-other',
      alive: true,
    });
    const app = createApiRoutes(
      createDeps({
        cache,
        worktreeScanner: scanWithFeatureWorktree,
        sessions: () => [deadSession, elsewhereSession],
      }),
    );

    const body = await (await app.request('/api/hygiene')).json();

    expect(body.nonTicketHarnessWorktrees).toEqual([]);
    expect(countHarnessCommitsBehindDefaultBranch).not.toHaveBeenCalledWith(
      '/projects/a/.claude/worktrees/mac-slow-diagnosis-7ddee1',
      expect.anything(),
    );
  });

  // bdboard-xjzj: bdboard-wadg (PR #480) の Opus レビュー指摘。既存テストは全て proj-a
  // (in_progress チケット持ち) だけを使うため、routes.ts の
  // `for (const worktree of nonTicketWorktrees) { measuredProjectIds.add(...) }` を
  // 削除してもどのテストも落ちない = ミューテーション未検出だった。in_progress チケットを
  // 一切持たない proj-b を用意し、getProjectMainBranch が proj-b に対しても呼ばれ、
  // nonTicketHarnessWorktrees の baseRef が解決された main branch (develop) を正しく
  // 反映することをアサートする。
  it('measures a project that has only a non-ticket worktree and no in_progress tickets', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    const b = project('proj-b', '/projects/b');
    cache.putProject({
      project: b,
      tickets: [],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const featureWorktreePath = '/projects/b/.claude/worktrees/only-feature';
    const scanner: WorktreeScanner = {
      scan: async (rootPath) => {
        if (rootPath === '/projects/b') {
          return {
            worktrees: [
              { path: '/projects/b', branch: 'main', isMain: true },
              {
                path: featureWorktreePath,
                branch: 'feature/only-feature',
                isMain: false,
              },
            ],
            bdBranches: [],
            complete: true,
          };
        }
        return {
          worktrees: [{ path: '/projects/a', branch: 'main', isMain: true }],
          bdBranches: [],
          complete: true,
        };
      },
      listChangedFiles: async () => [],
      countHarnessCommitsBehindDefaultBranch: async (_path, options) => ({
        commitsBehind: 63,
        baseRef: `origin/${options?.mainBranch ?? 'main'}`,
      }),
    };

    // proj-a と proj-b で異なる main branch を返す。proj-a には in_progress チケットも
    // 非チケット worktree も無いので正しい実装では呼ばれないはずだが、万一誤って measured
    // 対象に入っても baseRef で proj-a/proj-b どちらが解決されたか区別できるようにしておく。
    const getProjectMainBranch = vi.fn(async (rootPath: string) =>
      rootPath === '/projects/b' ? 'develop' : 'master',
    );
    const session = makeSession({ cwd: featureWorktreePath, alive: true });

    const app = createApiRoutes(
      createDeps({
        cache,
        worktreeScanner: scanner,
        getProjectMainBranch,
        sessions: () => [session],
      }),
    );

    const body = await (await app.request('/api/hygiene')).json();

    // proj-b は in_progress チケットを一切持たないので、これが呼ばれるのは非チケット
    // worktree 経由で measuredProjectIds に proj-b が追加された場合に限る。proj-a は
    // チケットも非チケット worktree も持たないので一切測られないはず (Opus レビュー指摘)。
    expect(getProjectMainBranch).toHaveBeenCalledTimes(1);
    expect(getProjectMainBranch).toHaveBeenCalledWith('/projects/b');
    expect(body.nonTicketHarnessWorktrees).toContainEqual({
      projectId: 'proj-b',
      worktreePath: featureWorktreePath,
      branchName: 'feature/only-feature',
      commitsBehind: 63,
      // 解決された main branch (develop) が baseRef に反映されていること自体が、
      // measuredProjectIds への追加が効いていることの証拠になる。
      baseRef: 'origin/develop',
      message: expect.stringContaining('feature/only-feature'),
    });
  });

  it('returns the in-flight overlaps of a single ticket for the detail panel', async () => {
    const { cache } = inFlightCache();
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: inFlightScanner(IN_FLIGHT_FILES) }),
    );

    const response = await app.request('/api/tickets/bdboard-x/in-flight-overlaps');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      { ticketId: 'bdboard-y', files: ['src/domain/hygiene.ts'] },
    ]);

    const noOverlap = await (
      await app.request('/api/tickets/bdboard-z/in-flight-overlaps')
    ).json();
    expect(noOverlap).toEqual([]);
  });

  it('returns an empty in-flight overlap list without a worktreeScanner', async () => {
    const { cache } = inFlightCache();
    const app = createApiRoutes(createDeps({ cache }));

    const response = await app.request('/api/tickets/bdboard-x/in-flight-overlaps');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('returns an empty in-flight overlap list when the ticket has no worktree', async () => {
    const { cache } = inFlightCache();
    const listChangedFiles = vi.fn(async () => ['src/domain/hygiene.ts']);
    const scanner: WorktreeScanner = {
      scan: async () => ({
        worktrees: [{ path: '/projects/a', branch: 'main', isMain: true }],
        bdBranches: [],
        complete: true,
      }),
      listChangedFiles,
    };
    const app = createApiRoutes(createDeps({ cache, worktreeScanner: scanner }));

    const response = await app.request('/api/tickets/bdboard-x/in-flight-overlaps');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(listChangedFiles).not.toHaveBeenCalled();
  });

  it('reuses one scan for /api/hygiene and the detail panel', async () => {
    const { cache } = inFlightCache();
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const listChangedFiles = vi.fn(base.listChangedFiles);
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: { ...base, listChangedFiles } }),
    );

    await app.request('/api/hygiene?projects=proj-a');
    const afterHygiene = listChangedFiles.mock.calls.length;
    expect(afterHygiene).toBeGreaterThan(0);

    // 同じプロジェクト集合なので、詳細パネルは 30 秒メモを引く
    const body = await (
      await app.request('/api/tickets/bdboard-x/in-flight-overlaps')
    ).json();

    expect(body).toEqual([{ ticketId: 'bdboard-y', files: ['src/domain/hygiene.ts'] }]);
    expect(listChangedFiles.mock.calls.length).toBe(afterHygiene);
  });

  it('does not reuse the memo after the project is refetched on close (bdboard-3tw.162)', async () => {
    const { cache } = inFlightCache();
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const listChangedFiles = vi.fn(base.listChangedFiles);
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: { ...base, listChangedFiles } }),
    );

    await app.request('/api/hygiene?projects=proj-a');
    const afterHygiene = listChangedFiles.mock.calls.length;

    // 他セッションが bdboard-y を close した → refresh が putProject し直す (board.changed と同じ条件)
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-x', projectId: a.id, status: 'in_progress' }),
        makeTicket({ id: 'bdboard-y', projectId: a.id, status: 'closed' }),
        makeTicket({ id: 'bdboard-z', projectId: a.id, status: 'in_progress' }),
      ],
      fingerprint: 'fp-a-2',
      fetchedAt: new Date(NOW.getTime() + 1_000),
    });

    const body = await (
      await app.request('/api/tickets/bdboard-x/in-flight-overlaps')
    ).json();

    expect(body).toEqual([]);
    expect(listChangedFiles.mock.calls.length).toBeGreaterThan(afterHygiene);

    // 新しい世代で計算し直した結果は、同じ世代のあいだは再び使い回す
    const afterRescan = listChangedFiles.mock.calls.length;
    await app.request('/api/hygiene?projects=proj-a');
    expect(listChangedFiles.mock.calls.length).toBe(afterRescan);
  });

  it('does not reuse the memo after a forced refetch that keeps the fingerprint', async () => {
    const { cache } = inFlightCache();
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const listChangedFiles = vi.fn(base.listChangedFiles);
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: { ...base, listChangedFiles } }),
    );

    await app.request('/api/hygiene?projects=proj-a');
    const afterHygiene = listChangedFiles.mock.calls.length;

    // 書き込み後の強制リフレッシュは fingerprint が同じでも fetchedAt を進める
    const entry = cache.getProject('proj-a');
    if (entry === undefined) {
      throw new Error('proj-a must be cached');
    }
    cache.putProject({ ...entry, fetchedAt: new Date(NOW.getTime() + 1_000) });

    await app.request('/api/tickets/bdboard-x/in-flight-overlaps');

    expect(listChangedFiles.mock.calls.length).toBeGreaterThan(afterHygiene);
  });

  // 世代を listProjects() 全体ではなく、メモのキーになったプロジェクトだけから作ることの回帰ガード
  it('keeps the memo when only another project is refetched', async () => {
    const { cache } = inFlightCache();
    const b = project('proj-b', '/projects/b');
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'other-1', projectId: b.id, status: 'open' })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const listChangedFiles = vi.fn(base.listChangedFiles);
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: { ...base, listChangedFiles } }),
    );

    await app.request('/api/hygiene?projects=proj-a');
    const afterHygiene = listChangedFiles.mock.calls.length;

    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'other-1', projectId: b.id, status: 'closed' })],
      fingerprint: 'fp-b-2',
      fetchedAt: new Date(NOW.getTime() + 1_000),
    });

    const body = await (
      await app.request('/api/tickets/bdboard-x/in-flight-overlaps')
    ).json();

    expect(body).toEqual([{ ticketId: 'bdboard-y', files: ['src/domain/hygiene.ts'] }]);
    expect(listChangedFiles.mock.calls.length).toBe(afterHygiene);
  });

  it('returns an empty in-flight overlap list for a closed ticket without touching git', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-x', projectId: a.id, status: 'closed' })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    const scan = vi.fn(async () => ({ worktrees: [], bdBranches: [], complete: true }));
    const app = createApiRoutes(
      createDeps({
        cache,
        worktreeScanner: { scan, listChangedFiles: async () => [] },
      }),
    );

    const response = await app.request('/api/tickets/bdboard-x/in-flight-overlaps');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
  });

  it('returns an empty in-flight overlap list for an unknown ticket', async () => {
    const { cache } = inFlightCache();
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: inFlightScanner(IN_FLIGHT_FILES) }),
    );

    const response = await app.request('/api/tickets/bdboard-nope/in-flight-overlaps');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('returns 501 when lease health dependencies are not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/lease-health');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'lease health not available' });
  });

  it('returns stale leases and reclaim scheduler status', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-active',
          projectId: a.id,
          status: 'in_progress',
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const leaseReader: LeaseReader = {
      listInProgressWithLease: vi.fn(async () => [
        {
          id: 'bdboard-stale',
          leaseExpiresAt: '2026-06-01T11:50:00.000Z',
          heartbeatAt: '2026-06-01T11:45:00.000Z',
          startedAt: null,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ]),
    };
    const reclaimScheduler: ReclaimScheduler = {
      start: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(() => ({
        enabled: true,
        intervalMs: 300_000,
        olderThan: '10m',
        projects: [
          {
            projectId: a.id,
            lastRunAt: '2026-06-01T11:55:00.000Z',
            reclaimedCount: 1,
            reclaimedCountUnknown: false,
            rawSummary: 'reclaimed 1 issue',
            lastError: null,
          },
        ],
      })),
    };

    const app = createApiRoutes(
      createDeps({ cache, leaseReader, reclaimScheduler }),
    );
    const response = await app.request('/api/lease-health');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.staleLeases).toEqual([
      {
        ticketId: 'bdboard-stale',
        projectId: 'proj-a',
        leaseExpiresAt: '2026-06-01T11:50:00.000Z',
        staleForMs: 10 * 60_000,
      },
    ]);
    expect(body.reclaim).toMatchObject({
      enabled: true,
      intervalMs: 300_000,
      olderThan: '10m',
      projects: [
        expect.objectContaining({
          projectId: 'proj-a',
          reclaimedCount: 1,
          lastError: null,
        }),
      ],
    });
    assertNoDates(body);
  });

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

  it('returns 501 when merge slot reader is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/merge-slot-status');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'merge slot status not available' });
  });

  it('returns held merge slot status for cached projects', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: projectA, ticketId: 'bdboard-a' }]);

    const mergeSlotReader: MergeSlotReader = {
      readMergeSlotSignal: vi.fn(async () => ({
        status: 'in_progress',
        holder: 'session-merge-holder',
        // 15 minutes before the suite's frozen NOW, so heldForMs below is a
        // real positive delta rather than clamping to 0 (a future-relative-
        // to-NOW updatedAt would silently mask a heldForMs regression).
        updatedAt: '2026-06-01T11:45:00.000Z',
      })),
    };

    const app = createApiRoutes(createDeps({ cache, mergeSlotReader }));
    const response = await app.request('/api/merge-slot-status');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      {
        projectId: 'proj-a',
        present: true,
        held: true,
        holder: 'session-merge-holder',
        heldSinceIso: '2026-06-01T11:45:00.000Z',
        heldForMs: 15 * 60_000,
        isLongHeld: false,
      },
    ]);
    assertNoDates(body);
  });

  it('filters merge slot status by projects query parameter', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    const projectB = project('proj-b', '/projects/b');
    seedCache(cache, [
      { project: projectA, ticketId: 'bdboard-a' },
      { project: projectB, ticketId: 'bdboard-b' },
    ]);

    const readMergeSlotSignal = vi.fn(async () => ({
      status: 'open',
      holder: null,
      updatedAt: '2026-08-17T10:48:26Z',
    }));
    const mergeSlotReader: MergeSlotReader = { readMergeSlotSignal };

    const app = createApiRoutes(createDeps({ cache, mergeSlotReader }));
    const response = await app.request(
      `/api/merge-slot-status?projects=${encodeURIComponent(projectA.id)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]?.projectId).toBe('proj-a');
    expect(readMergeSlotSignal).toHaveBeenCalledTimes(1);
    expect(readMergeSlotSignal).toHaveBeenCalledWith('/projects/a');
  });

  it('returns 501 when human decisions port is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/tickets/pending-decisions');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'pending decisions not available' });
  });

  it('returns pending decisions from cache without shelling out to bd', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    const projectB = project('proj-b', '/projects/b');
    cache.putProject({
      project: projectA,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: projectA.id })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
      pendingDecisions: [
        {
          id: 'bdboard-a',
          kind: 'gate',
          question: 'Q1?',
          options: [{ label: 'Yes', value: 'yes' }],
          allowFreeform: true,
        },
      ],
    });
    cache.putProject({
      project: projectB,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: projectB.id })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => {
        throw new Error('should not be called');
      }),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request('/api/tickets/pending-decisions');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(humanDecisions.listPendingDecisions).not.toHaveBeenCalled();
    expect(body).toEqual([
      {
        id: 'bdboard-a',
        projectId: 'proj-a',
        kind: 'gate',
        question: 'Q1?',
        options: [{ label: 'Yes', value: 'yes' }],
        allowFreeform: true,
      },
    ]);
  });

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

  describe('GET /api/tickets/:id sessionLinks', () => {
    it('includes transcript-sourced links from deps.links', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

      const links = () => [
        makeSessionLink({
          ticketId: 'bdboard-a',
          sessionId: 'sess-inferred',
          source: 'transcript',
        }),
        // Different ticket: must not leak into bdboard-a's sessionLinks.
        makeSessionLink({ ticketId: 'bdboard-other', sessionId: 'sess-other' }),
      ];

      const app = createApiRoutes(createDeps({ cache, links }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionLinks).toEqual([
        { sessionId: 'sess-inferred', source: 'transcript' },
      ]);
    });

    it('merges the cached manual link, preferring metadata over transcript for the same session', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{
        project: a,
        ticketId: 'bdboard-a',
        ticket: { manualSessionId: 'sess-shared' },
      }]);

      const links = () => [
        makeSessionLink({
          ticketId: 'bdboard-a',
          sessionId: 'sess-shared',
          source: 'transcript',
        }),
      ];
      const app = createApiRoutes(createDeps({ cache, links }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionLinks).toEqual([
        { sessionId: 'sess-shared', source: 'metadata' },
      ]);
    });

    it('includes models cached with the ticket in stage order', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{
        project: a,
        ticketId: 'bdboard-a',
        ticket: {
          models: [
            { stage: 'implement', model: 'composer-2.5' },
            { stage: 'test', model: 'opus' },
            { stage: 'review', model: 'fable' },
          ],
        },
      }]);

      const app = createApiRoutes(createDeps({ cache }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.models).toEqual([
        { stage: 'implement', model: 'composer-2.5' },
        { stage: 'test', model: 'opus' },
        { stage: 'review', model: 'fable' },
      ]);
    });

    it('keeps distinct manual and inferred links side by side', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{
        project: a,
        ticketId: 'bdboard-a',
        ticket: { manualSessionId: 'sess-manual' },
      }]);

      const links = () => [
        makeSessionLink({
          ticketId: 'bdboard-a',
          sessionId: 'sess-inferred',
          source: 'transcript',
        }),
      ];
      const app = createApiRoutes(createDeps({ cache, links }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionLinks).toEqual([
        { sessionId: 'sess-inferred', source: 'transcript' },
        { sessionId: 'sess-manual', source: 'metadata' },
      ]);
    });

    it('returns no manual link and empty models when the cache has no metadata', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

      const app = createApiRoutes(createDeps({ cache }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionLinks).toEqual([]);
      expect(body.models).toEqual([]);
      expect(body.id).toBe('bdboard-a');
    });

    it('returns an empty sessionLinks array when no links are configured', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

      const app = createApiRoutes(createDeps({ cache }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionLinks).toEqual([]);
    });
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
