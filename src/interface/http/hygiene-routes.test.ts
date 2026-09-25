import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { makeSession, makeTicket } from '../../domain/test-support.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import type { LeaseReader } from '../../application/ports/lease-reader.js';
import type { MergeSlotReader } from '../../application/ports/merge-slot-reader.js';
import type { PrStatus } from '../../domain/pr-link.js';
import type { PrStatusReader } from '../../application/ports/pr-status-reader.js';
import type { ReclaimScheduler } from '../../application/lease/reclaim-scheduler.js';
import { NOW, project, createFakeBoardCache, seedCache, createDeps, assertNoDates, inFlightScanner, inFlightCache, IN_FLIGHT_FILES } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
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
      hasCommonAncestor: true,
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
      hasCommonAncestor: true,
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
        hasCommonAncestor: true,
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
  it('omits a non-ticket worktree with no live session, and never measures it', async () => {
    const { cache } = inFlightCache();
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const countHarnessCommitsBehindDefaultBranch = vi.fn(async (_path, options) => ({
      commitsBehind: 63,
      baseRef: `origin/${options?.mainBranch ?? 'main'}`,
      hasCommonAncestor: true,
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
        hasCommonAncestor: true,
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
});
