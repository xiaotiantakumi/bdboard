import { describe, expect, it, vi, type Mock } from 'vitest';
import { Hono } from 'hono';
import { compareStrings } from '../../domain/compare.js';
import type { IssueComment } from '../../domain/issue-comment.js';
import { makeSession, makeSessionLink, makeTicket } from '../../domain/test-support.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../../application/ports/board-cache-fakes.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { ProcessScanner } from '../../application/ports/process-scanner.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import type { DependencyWriterPort } from '../../application/ports/dependency-writer.js';
import {
  PriorityConflictError,
  StatusConflictError,
  type IssueWriterPort,
} from '../../application/ports/issue-writer.js';
import type { SessionLinkWriterPort } from '../../application/ports/session-link-writer.js';
import type { SessionTailReader } from '../../application/ports/session-tail-reader.js';
import type { LeaseReader } from '../../application/ports/lease-reader.js';
import type { MergeSlotReader } from '../../application/ports/merge-slot-reader.js';
import type { PrStatus } from '../../domain/pr-link.js';
import type { PrStatusReader } from '../../application/ports/pr-status-reader.js';
import type { ReclaimScheduler } from '../../application/lease/reclaim-scheduler.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { createEventHub } from '../sse/event-hub.js';
import { createBasicAuthMiddleware } from './basic-auth.js';
import { createApiRoutes, type ApiDeps, type ApiStatus } from './routes.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
    },
  },
};

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
  const entries = new Map<string, CachedProject>();

  return {
    entries,
    getProject(projectId: string): CachedProject | undefined {
      return entries.get(projectId);
    },
    putProject(entry: CachedProject): void {
      entries.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      entries.delete(projectId);
    },
    clear(): void {
      entries.clear();
    },
    getTranscriptOffset(): number | undefined {
      return undefined;
    },
    setTranscriptOffset(): void {},
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

function seedCache(
  cache: BoardCache,
  items: readonly {
    readonly project: Project;
    readonly ticketId: string;
    readonly ticket?: Parameters<typeof makeTicket>[0];
  }[],
): void {
  for (const item of items) {
    cache.putProject({
      project: item.project,
      tickets: [
        makeTicket({
          id: item.ticketId,
          projectId: item.project.id,
          ...item.ticket,
        }),
      ],
      fingerprint: `fp-${item.project.id}`,
      fetchedAt: NOW,
    });
  }
}

type RefreshMock = Mock<() => Promise<void>>;

function createDeps(
  overrides: Partial<Omit<ApiDeps, 'refresh'>> & { refresh?: RefreshMock } = {},
): ApiDeps & { refresh: RefreshMock } {
  const cache = createFakeBoardCache();
  const events = createEventHub();
  const status: ApiStatus = {
    lastRefreshAt: NOW,
    errors: [],
    projectCount: 0,
  };
  const refresh: RefreshMock = overrides.refresh ?? vi.fn(async () => {});

  return {
    cache,
    applicationVersion: {
      getVersion: () => 'test-version',
    },
    now: () => NOW,
    getStatus: () => status,
    events,
    ...overrides,
    // Keep `refresh` after the spread so the declared Mock type is preserved.
    refresh,
  };
}

function assertNoDates(value: unknown): void {
  if (value instanceof Date) {
    throw new Error('Found Date instance in JSON payload');
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoDates(item);
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assertNoDates((value as Record<string, unknown>)[key]);
    }
  }
}

describe('createApiRoutes', () => {
  it('returns health payload with ISO now and application version', async () => {
    const deps = createDeps({
      applicationVersion: {
        getVersion: () => '1.2.3',
      },
    });
    const app = createApiRoutes(deps);

    const response = await app.request('/api/health');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, now: NOW.toISOString(), version: '1.2.3' });
  });

  it('returns status with ISO lastRefreshAt', async () => {
    const deps = createDeps();
    const app = createApiRoutes(deps);

    const response = await app.request('/api/status');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.lastRefreshAt).toBe(NOW.toISOString());
    expect(body.projectCount).toBe(0);
    expect(body.errors).toEqual([]);
    expect(body.boardTimeZone).toBeNull();
  });

  it('returns projects sorted by rootPath', async () => {
    const cache = createFakeBoardCache();
    const z = project('/z', '/projects/z');
    const a = project('/a', '/projects/a');
    seedCache(cache, [
      { project: z, ticketId: 'bdboard-z' },
      { project: a, ticketId: 'bdboard-a' },
    ]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/projects');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.map((entry: { rootPath: string }) => entry.rootPath)).toEqual([
      '/projects/a',
      '/projects/z',
    ]);
  });

  it('rejects invalid board view', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/board?view=bogus');
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'invalid view',
      allowed: ['merged', 'split'],
    });
  });

  it('returns board JSON without Date objects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board');
    const body = await response.json();

    expect(response.status).toBe(200);
    assertNoDates(body);
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(response.headers.get('ETag')).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('puts a human-labeled ticket in the awaiting_human lane and out of ready', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-waiting', projectId: a.id }),
        makeTicket({ id: 'bdboard-plain', projectId: a.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
      pendingDecisions: [{ id: 'bdboard-waiting', allowFreeform: true }],
    });

    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request('/api/board');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(humanDecisions.listPendingDecisions).not.toHaveBeenCalled();
    expect(
      body.merged.lanes.awaiting_human.map(
        (card: { ticket: { id: string } }) => card.ticket.id,
      ),
    ).toEqual(['bdboard-waiting']);
    expect(
      body.merged.lanes.ready.map((card: { ticket: { id: string } }) => card.ticket.id),
    ).toEqual(['bdboard-plain']);
  });

  it('leaves awaiting_human empty when no humanDecisions port is configured', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-plain' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged.lanes.awaiting_human).toEqual([]);
    expect(
      body.merged.lanes.ready.map((card: { ticket: { id: string } }) => card.ticket.id),
    ).toEqual(['bdboard-plain']);
  });

  it('returns 304 with empty body when If-None-Match matches ETag', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const first = await app.request('/api/board');
    const etag = first.headers.get('ETag');
    expect(etag).not.toBeNull();

    const conditional = await app.request('/api/board', {
      headers: { 'If-None-Match': etag! },
    });

    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('ETag')).toBe(etag);
    expect(conditional.headers.get('Cache-Control')).toBe('no-cache');
    expect(conditional.headers.get('Vary')).toBe('Accept-Encoding');
    expect(await conditional.text()).toBe('');
  });

  it('keeps ETag stable when generatedAt changes but board content is identical', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const nowEarlier = new Date('2026-06-01T12:00:00.000Z');
    const nowLater = new Date('2026-06-02T15:30:00.000Z');

    const appEarlier = createApiRoutes(
      createDeps({ cache, now: () => nowEarlier }),
    );
    const appLater = createApiRoutes(
      createDeps({ cache, now: () => nowLater }),
    );

    const earlier = await appEarlier.request('/api/board');
    const later = await appLater.request('/api/board');

    expect(earlier.headers.get('ETag')).toBe(later.headers.get('ETag'));
    expect((await earlier.json()).generatedAt).toBe(nowEarlier.toISOString());
    expect((await later.json()).generatedAt).toBe(nowLater.toISOString());
  });

  it('changes ETag when board content changes', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const deps = createDeps({ cache });
    const app = createApiRoutes(deps);

    const before = await app.request('/api/board');
    const etagBefore = before.headers.get('ETag');

    const b = project('/b', '/projects/b');
    seedCache(cache, [{ project: b, ticketId: 'bdboard-b' }]);

    const after = await app.request('/api/board');
    const etagAfter = after.headers.get('ETag');

    expect(etagBefore).not.toBeNull();
    expect(etagAfter).not.toBeNull();
    expect(etagBefore).not.toBe(etagAfter);
  });

  it('returns 401 not 304 when auth is enabled and credentials are missing', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const inner = createApiRoutes(createDeps({ cache }));
    const app = new Hono();
    app.use(
      '*',
      createBasicAuthMiddleware({
        kind: 'enabled',
        // Placeholder-shaped on purpose: adjacent username/password fixture
        // values are what GitGuardian's Username Password detector fires on
        // by pattern, regardless of whether the value is a real secret (see
        // CLAUDE.md).
        config: { username: 'example-user', password: 'example-password' },
      }),
    );
    app.route('/', inner);

    const authorized = await app.request('/api/board', {
      headers: {
        Authorization: `Basic ${Buffer.from('example-user:example-password').toString('base64')}`,
      },
    });
    const etag = authorized.headers.get('ETag');
    expect(authorized.status).toBe(200);
    expect(etag).not.toBeNull();

    const missingAuth = await app.request('/api/board', {
      headers: { 'If-None-Match': etag! },
    });
    expect(missingAuth.status).toBe(401);

    const wrongAuth = await app.request('/api/board', {
      headers: {
        'If-None-Match': etag!,
        Authorization: `Basic ${Buffer.from('example-user:wrong-pass').toString('base64')}`,
      },
    });
    expect(wrongAuth.status).toBe(401);
  });

  it('filters board by projects query', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const app = createApiRoutes(createDeps({ cache }));
    // view=split: mode=merged(既定)ではbdboard-3tw.86でprojectsが空配列になるため、
    // projectsのフィルタ結果を検証するにはsplitビューを使う。
    const response = await app.request(
      `/api/board?view=split&projects=${encodeURIComponent(b.id)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].project.id).toBe(b.id);
  });

  it('treats empty projects query as no filter', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?view=split&projects=');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.projects).toHaveLength(2);
  });

  it('empties projects in the default (merged) view so tickets are not sent twice', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe('merged');
    expect(body.projects).toEqual([]);
    expect(body.merged).not.toBeNull();
  });

  it('does not send the same ticket id twice in the merged view response', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?view=merged');
    const bodyText = await response.text();

    expect(response.status).toBe(200);
    expect((bodyText.match(/bdboard-a/g) ?? []).length).toBe(1);
    expect((bodyText.match(/bdboard-b/g) ?? []).length).toBe(1);
  });

  it('filters the board by epicId (bdboard-3tw.95)', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-epic', projectId: a.id }),
        makeTicket({ id: 'bdboard-child', projectId: a.id, parentId: 'bdboard-epic' }),
        makeTicket({ id: 'bdboard-unrelated', projectId: a.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?epicId=bdboard-epic');
    const body = await response.json();

    expect(response.status).toBe(200);
    const ids = body.merged.lanes.ready.map(
      (card: { ticket: { id: string } }) => card.ticket.id,
    );
    expect(ids.sort()).toEqual(['bdboard-child', 'bdboard-epic'].sort());
    expect(body.merged.cardCount).toBe(2);
  });

  it('treats an empty epicId query as no filter', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?epicId=');
    const body = await response.json();

    expect(response.status).toBe(200);
    const ids = body.merged.lanes.ready.map(
      (card: { ticket: { id: string } }) => card.ticket.id,
    );
    expect(ids).toEqual(['bdboard-a']);
  });

  it('returns 200 with an empty board for an unknown epicId', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?epicId=bdboard-does-not-exist');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged.cardCount).toBe(0);
    expect(body.merged.lanes.ready).toEqual([]);
    expect(body.merged.lanes.blocked).toEqual([]);
    expect(body.merged.lanes.done).toEqual([]);
  });

  it('keeps split view fully populated (no dedup applies there)', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?view=split');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged).toBeNull();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].board.lanes.ready.map((c: { ticket: { id: string } }) => c.ticket.id)).toEqual([
      'bdboard-a',
    ]);
  });

  it('truncates the done lane to the default closedLimit and reports closedTotal', async () => {
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
    const response = await app.request('/api/board');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged.lanes.done).toHaveLength(100);
    expect(body.merged.closedTotal).toBe(120);
    // 最近closedされた順に残る: bdboard-closed-0 が最新
    expect(body.merged.lanes.done[0].ticket.id).toBe('bdboard-closed-0');
    // load-bearing (bdboard-3tw.86 追補, 議長レビュー指摘): 切り捨てられた20件は
    // カードとしては消えるが、IDだけは merged.truncatedClosedIds として実際の
    // /api/board レスポンスに載っていること(既知ID自動リンク bdboard-3tw.64 の配線)。
    expect(body.merged.truncatedClosedIds).toHaveLength(20);
    expect(body.merged.truncatedClosedIds).toContain('bdboard-closed-119');
    expect(body.merged.truncatedClosedIds).not.toContain('bdboard-closed-0');
  });

  it('honors an explicit closedLimit query param', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const closedTickets = Array.from({ length: 10 }, (_, i) =>
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
    const response = await app.request('/api/board?closedLimit=3');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged.lanes.done).toHaveLength(3);
    expect(body.merged.closedTotal).toBe(10);
    expect(body.merged.truncatedClosedIds).toHaveLength(7);
    expect(body.merged.truncatedClosedIds).toContain('bdboard-closed-9');
  });

  it('reports truncatedClosedIds per project in split view too', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const closedTickets = Array.from({ length: 5 }, (_, i) =>
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
    const response = await app.request('/api/board?view=split&closedLimit=2');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged).toBeNull();
    expect(body.projects[0].board.lanes.done).toHaveLength(2);
    expect(body.projects[0].board.closedTotal).toBe(5);
    expect(body.projects[0].board.truncatedClosedIds).toHaveLength(3);
    expect(body.projects[0].board.truncatedClosedIds).toContain('bdboard-closed-4');
  });

  it('filters activity by projects query', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id, createdAt })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, createdAt })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request(`/api/activity?projects=${encodeURIComponent(b.id)}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].projectId).toBe(b.id);
    expect(body[0].id).toBe('bdboard-b');
  });

  it('filters stats by projects query', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a-closed',
          projectId: a.id,
          closedAt,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-b-closed',
          projectId: b.id,
          closedAt,
        }),
        makeTicket({
          id: 'bdboard-b-closed-2',
          projectId: b.id,
          closedAt,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request(`/api/stats?weeks=1&projects=${encodeURIComponent(a.id)}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].projectId).toBe(a.id);
    expect(body.totals.weeklyCloses[0].count).toBe(1);
  });

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

  it('returns search results across projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    cache.putProject({
      project: { ...a, name: 'Alpha Project' },
      tickets: [
        makeTicket({
          id: 'bdboard-alpha',
          projectId: a.id,
          title: 'Alpha feature',
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: { ...b, name: 'Beta Project' },
      tickets: [
        makeTicket({
          id: 'bdboard-beta',
          projectId: b.id,
          title: 'Beta feature',
          description: 'mentions alpha',
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/search?q=alpha');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeNull();
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      id: 'bdboard-alpha',
      projectId: a.id,
      projectName: 'Alpha Project',
      title: 'Alpha feature',
      status: 'open',
      priority: 2,
      issueType: 'task',
    });
    expect(body[1].id).toBe('bdboard-beta');
    assertNoDates(body);
  });

  it('returns empty array for empty search query', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));

    const missing = await app.request('/api/search');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual([]);

    const blank = await app.request('/api/search?q=');
    expect(blank.status).toBe(200);
    expect(await blank.json()).toEqual([]);

    const whitespace = await app.request('/api/search?q=%20%20');
    expect(whitespace.status).toBe(200);
    expect(await whitespace.json()).toEqual([]);
  });

  it('clamps search limit between 1 and 50', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const tickets = Array.from({ length: 60 }, (_, index) =>
      makeTicket({
        id: `bdboard-${index}`,
        projectId: a.id,
        title: 'searchable ticket',
      }),
    );
    cache.putProject({
      project: a,
      tickets,
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));

    const over = await app.request('/api/search?q=searchable&limit=100');
    expect(over.status).toBe(200);
    expect((await over.json()) as unknown[]).toHaveLength(50);

    const under = await app.request('/api/search?q=searchable&limit=0');
    expect(under.status).toBe(200);
    expect((await under.json()) as unknown[]).toHaveLength(1);

    const defaultLimit = await app.request('/api/search?q=searchable');
    expect(defaultLimit.status).toBe(200);
    expect((await defaultLimit.json()) as unknown[]).toHaveLength(30);
  });

  it('returns activity events with ISO timestamps and no ETag', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');
    const startedAt = new Date('2026-06-01T09:00:00.000Z');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: { ...a, name: 'Alpha Project' },
      tickets: [
        makeTicket({
          id: 'bdboard-activity',
          projectId: a.id,
          title: 'Activity ticket',
          createdAt,
          startedAt,
          closedAt,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/activity');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeNull();
    expect(body).toHaveLength(3);
    expect(body[0]).toEqual({
      kind: 'closed',
      at: closedAt.toISOString(),
      id: 'bdboard-activity',
      projectId: a.id,
      projectName: 'Alpha Project',
      title: 'Activity ticket',
      status: 'open',
      priority: 2,
      issueType: 'task',
    });
    assertNoDates(body);
  });

  it('clamps activity days between 1 and 30 and limit between 1 and 200', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const tickets = Array.from({ length: 250 }, (_, index) =>
      makeTicket({
        id: `bdboard-${index}`,
        projectId: a.id,
        createdAt: new Date(NOW.getTime() - index * 60_000),
      }),
    );
    cache.putProject({
      project: a,
      tickets,
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));

    const overLimit = await app.request('/api/activity?limit=500');
    expect(overLimit.status).toBe(200);
    expect((await overLimit.json()) as unknown[]).toHaveLength(200);

    const underLimit = await app.request('/api/activity?limit=0');
    expect(underLimit.status).toBe(200);
    expect((await underLimit.json()) as unknown[]).toHaveLength(1);

    const defaultLimit = await app.request('/api/activity');
    expect(defaultLimit.status).toBe(200);
    expect((await defaultLimit.json()) as unknown[]).toHaveLength(100);

    const overDays = await app.request('/api/activity?days=99');
    expect(overDays.status).toBe(200);
    expect((await overDays.json()) as unknown[]).toHaveLength(100);

    const underDays = await app.request('/api/activity?days=0');
    expect(underDays.status).toBe(200);
    expect((await underDays.json()) as unknown[]).toHaveLength(100);

    const invalidDays = await app.request('/api/activity?days=abc&limit=xyz');
    expect(invalidDays.status).toBe(200);
    expect((await invalidDays.json()) as unknown[]).toHaveLength(100);
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

  it('returns throughput stats with ISO weekStart and projectName', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: { ...a, name: 'Alpha Project' },
      tickets: [
        makeTicket({
          id: 'bdboard-stats-closed',
          projectId: a.id,
          closedAt,
        }),
        makeTicket({
          id: 'bdboard-stats-open',
          projectId: a.id,
          createdAt: new Date('2026-05-30T10:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/stats?weeks=1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeNull();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({
      projectId: a.id,
      projectName: 'Alpha Project',
      weeklyCloses: [{ count: 1 }],
      openTicketAge: {
        d0to1: 0,
        d1to7: 1,
        d7to30: 0,
        d30plus: 0,
      },
    });
    expect(typeof body.projects[0].weeklyCloses[0].weekStart).toBe('string');
    expect(body.totals.weeklyCloses[0].count).toBe(1);
    assertNoDates(body);
  });

  it('returns model stats with ISO weekStart and project filter', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-model-a',
          projectId: a.id,
          closedAt,
          models: [{ stage: 'implement', model: 'composer-2.5' }],
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-model-b',
          projectId: b.id,
          closedAt,
          models: [{ stage: 'implement', model: 'gpt-5' }],
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request(
      `/api/model-stats?weeks=1&projects=${encodeURIComponent(a.id)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.weeklyCloses).toHaveLength(1);
    expect(typeof body.weeklyCloses[0].weekStart).toBe('string');
    expect(body.weeklyCloses[0].counts).toEqual({ 'composer-2.5': 1 });
    expect(body.stageModelDistribution).toEqual([
      { stage: 'implement', counts: { 'composer-2.5': 1 } },
    ]);
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
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      kind: 'overdue_defer',
      ticketId: 'bdboard-overdue',
      projectId: a.id,
      severity: 'warning',
    });
    assertNoDates(body);
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
      })),
    };

    const app = createApiRoutes(createDeps({ cache, worktreeScanner }));
    const response = await app.request('/api/hygiene');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
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
        ({ state: 'open', checkStatus: 'pass' }) satisfies PrStatus,
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
        ({ state: 'merged', checkStatus: 'pass' }) satisfies PrStatus,
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

  it('clamps stats weeks between 1 and 26 and defaults invalid values to 8', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));

    const overWeeks = await app.request('/api/stats?weeks=100');
    expect(overWeeks.status).toBe(200);
    expect((await overWeeks.json()).totals.weeklyCloses).toHaveLength(26);

    const underWeeks = await app.request('/api/stats?weeks=0');
    expect(underWeeks.status).toBe(200);
    expect((await underWeeks.json()).totals.weeklyCloses).toHaveLength(1);

    const defaultWeeks = await app.request('/api/stats');
    expect(defaultWeeks.status).toBe(200);
    expect((await defaultWeeks.json()).totals.weeklyCloses).toHaveLength(8);

    const invalidWeeks = await app.request('/api/stats?weeks=abc');
    expect(invalidWeeks.status).toBe(200);
    expect((await invalidWeeks.json()).totals.weeklyCloses).toHaveLength(8);
  });

  it('returns comments for a ticket on the board', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const ticketId = 'bdboard-3tw.10';
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: ticketId,
          projectId: a.id,
          commentCount: 2,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const comments: IssueComment[] = [
      {
        id: 'comment-1',
        issueId: ticketId,
        author: 'Alice',
        text: 'First',
        createdAt: new Date('2026-08-14T10:00:00Z'),
      },
      {
        id: 'comment-2',
        issueId: ticketId,
        author: 'Bob',
        text: 'Second',
        createdAt: new Date('2026-08-14T11:00:00Z'),
      },
    ];

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => comments),
    };

    const app = createApiRoutes(createDeps({ cache, commentReader }));
    const response = await app.request(`/api/comments/${ticketId}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      {
        id: 'comment-1',
        issueId: ticketId,
        author: 'Alice',
        text: 'First',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
      {
        id: 'comment-2',
        issueId: ticketId,
        author: 'Bob',
        text: 'Second',
        createdAt: '2026-08-14T11:00:00.000Z',
      },
    ]);
    expect(commentReader.listComments).toHaveBeenCalledWith('/projects/a', ticketId);
    expect(response.headers.get('ETag')).toBeNull();
  });

  it('returns 404 for comments when ticket is missing', async () => {
    const commentReader: CommentReader = {
      listComments: vi.fn(async () => []),
    };
    const app = createApiRoutes(createDeps({ commentReader }));
    const response = await app.request('/api/comments/missing-ticket');
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'ticket not found', id: 'missing-ticket' });
    expect(commentReader.listComments).not.toHaveBeenCalled();
  });

  it('returns 502 when comment reader fails', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const ticketId = 'bdboard-3tw.10';
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: ticketId, projectId: a.id, commentCount: 1 })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => {
        throw new BdError('lock-contention', ticketId, 'database is locked');
      }),
    };

    const app = createApiRoutes(createDeps({ cache, commentReader }));
    const response = await app.request(`/api/comments/${ticketId}`);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: 'failed to load comments',
      detail: 'database is locked',
    });
  });

  it('returns 501 when comment reader is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/comments/bdboard-abc');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'comments not available' });
  });

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
      respond: vi.fn(async () => {}),
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

    const respond = vi.fn(async () => {});
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond,
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          choice: 'yes',
          freeform: '  free text answer  ',
        }),
      },
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
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

    const respond = vi.fn(async () => {});
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond,
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'yes' }),
      },
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(respond).toHaveBeenCalledWith('/projects/a', 'bdboard-a', 'yes');
  });

  it('returns 400 when decision body has neither choice nor freeform', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'choice or freeform is required' });
  });

  it('returns 403 for decision POST through tunnel headers', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ choice: 'yes' }),
      },
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
  });

  it('returns 404 for decision POST when ticket is not in cache', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ humanDecisions }));
    const response = await app.request(
      '/api/tickets/missing-ticket/decision',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'yes' }),
      },
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
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close', reason: 'shipped' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));

    const deferResponse = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'defer', untilDate: '2026-08-22' }),
      },
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
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'priority', priority: 2 }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undefer' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undefer' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ action: 'undefer' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bogus' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ action: 'claim' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));
    const response = await app.request(
      '/api/tickets/missing-ticket/quick-action',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      },
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
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'defer' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'undefer',
          untilDate: '2026-08-10',
        }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'defer' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'priority',
          previousPriority: 3,
          expectedCurrentPriority: 1,
        }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'priority',
          previousPriority: 3,
          expectedCurrentPriority: 1,
        }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));

    // priority undo without previousPriority must be rejected: silently
    // defaulting would restore the wrong value instead of surfacing the
    // missing precondition.
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'priority' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));

    // expectedCurrentPriority is the CAS check's expected value (bdboard-3tw.82).
    // Without it the route cannot detect a conflict, so it must be rejected
    // rather than silently skipping the check.
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'priority', previousPriority: 3 }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));

    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undefer' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ action: 'claim' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));
    const response = await app.request(
      '/api/tickets/missing-ticket/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/quick-action/undo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      },
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
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'progress update' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ text: 'hello' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/comment',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      },
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
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      },
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
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      },
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
      { method: 'DELETE' },
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
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      },
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
      {
        method: 'DELETE',
        headers: {
          'CF-Ray': 'abc123',
        },
      },
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
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      },
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
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      },
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
      { method: 'DELETE' },
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
      { method: 'DELETE' },
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

  it('returns 501 when issue writer port is not configured for label add', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request(
      '/api/tickets/bdboard-a/labels',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'human' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/labels',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'human' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/labels',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: '-rf' }),
      },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/labels/human',
      { method: 'DELETE' },
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
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, issueWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/labels/human',
      { method: 'DELETE' },
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

  it('calls refresh handler on POST /api/refresh', async () => {
    const deps = createDeps();
    const app = createApiRoutes(deps);

    const response = await app.request(
      '/api/refresh',
      { method: 'POST' },
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(deps.refresh).toHaveBeenCalledTimes(1);
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

  it('returns projects with session fields when provider is present', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const aliveInA = makeSession({
      sessionId: 'session-alive-a',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const deadInA = makeSession({
      sessionId: 'session-dead-a',
      cwd: '/projects/a/subdir',
      alive: false,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const worktreeInA = makeSession({
      sessionId: 'session-worktree-a',
      cwd: '/projects/a/.claude/worktrees/x',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const sessionInB = makeSession({
      sessionId: 'session-b',
      cwd: '/projects/b',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [aliveInA, deadInA, worktreeInA, sessionInB],
      }),
    );

    const response = await app.request('/api/projects');
    const body = await response.json();

    expect(response.status).toBe(200);

    const projectA = body.find((entry: { id: string }) => entry.id === a.id);
    const projectB = body.find((entry: { id: string }) => entry.id === b.id);

    expect(projectA.activeSessionCount).toBe(2);
    expect(projectA.sessionCount).toBe(3);
    expect(projectA.sessions).toHaveLength(3);
    expect(projectA.sessions.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(
      expect.arrayContaining([
        'session-alive-a',
        'session-dead-a',
        'session-worktree-a',
      ]),
    );

    expect(projectB.activeSessionCount).toBe(1);
    expect(projectB.sessionCount).toBe(1);
    expect(projectB.sessions).toHaveLength(1);
    expect(projectB.sessions[0].sessionId).toBe('session-b');
  });

  it('returns empty session fields on projects when provider is absent', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/projects');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0].activeSessionCount).toBe(0);
    expect(body[0].sessionCount).toBe(0);
    expect(body[0].sessions).toEqual([]);
  });

  it('includes activeSessionCount on board split view projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const aliveInA = makeSession({
      sessionId: 'session-alive-a',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const deadInA = makeSession({
      sessionId: 'session-dead-a',
      cwd: '/projects/a',
      alive: false,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const sessionInB = makeSession({
      sessionId: 'session-b',
      cwd: '/projects/other',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [aliveInA, deadInA, sessionInB],
      }),
    );

    const response = await app.request('/api/board?view=split');
    const body = await response.json();

    expect(response.status).toBe(200);

    const projectA = body.projects.find(
      (entry: { project: { id: string } }) => entry.project.id === a.id,
    );
    const projectB = body.projects.find(
      (entry: { project: { id: string } }) => entry.project.id === b.id,
    );

    expect(projectA.project.activeSessionCount).toBe(1);
    expect(projectA.project.sessionCount).toBe(2);
    expect(projectA.project.sessions).toHaveLength(2);
    expect(projectB.project.activeSessionCount).toBe(0);
    expect(projectB.project.sessionCount).toBe(0);
    expect(projectB.project.sessions).toEqual([]);
  });

  it('returns 500 when refresh fails', async () => {
    const deps = createDeps({
      refresh: vi.fn(async () => {
        throw new Error('refresh boom');
      }),
    });
    const app = createApiRoutes(deps);

    const response = await app.request(
      '/api/refresh',
      { method: 'POST' },
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'refresh failed', detail: 'refresh boom' });
  });

  it('subscribes during SSE and cleans up on abort', async () => {
    const events = createEventHub();
    const deps = createDeps({ events });
    const app = createApiRoutes(deps);

    expect(events.subscriberCount()).toBe(0);

    const controller = new AbortController();
    const requestPromise = app.request('/api/events', {
      signal: controller.signal,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(events.subscriberCount()).toBe(1);

    controller.abort();

    await Promise.resolve(requestPromise).catch(() => {});

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(events.subscriberCount()).toBe(0);
  });

  it('relays notification events over SSE', async () => {
    const events = createEventHub();
    const deps = createDeps({ events });
    const app = createApiRoutes(deps);

    const controller = new AbortController();
    const requestPromise = app.request('/api/events', {
      signal: controller.signal,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    events.publish({
      name: 'notification',
      data: {
        kind: 'ticket_ready',
        ticketId: 'bdboard-ready',
        occurredAt: NOW.toISOString(),
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    controller.abort();

    const response = await requestPromise;
    const bodyText = await response.text();

    expect(bodyText).toContain('event: notification');
    expect(bodyText).toContain('"kind":"ticket_ready"');
    expect(bodyText).toContain('"ticketId":"bdboard-ready"');
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
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        },
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
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        },
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
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: '' }),
        },
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
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        },
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
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Ray': 'abc123',
          },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        },
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
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-1' }),
        },
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
        { method: 'DELETE' },
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
        { method: 'DELETE' },
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
        { method: 'DELETE' },
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
        {
          method: 'DELETE',
          headers: { 'CF-Ray': 'abc123' },
        },
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
        { method: 'DELETE' },
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
      {
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ action: 'claim' }),
      },
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
      {
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ action: 'undefer' }),
      },
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(issueWriter.undefer).toHaveBeenCalledWith('/root/a', 'bdboard-a');
  });

  it('allows a pending-decision response through the tunnel', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn(async () => {}),
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
      {
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ choice: 'yes' }),
      },
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
      {
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ text: 'from my phone' }),
      },
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
      {
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ action: 'claim' }),
      },
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
      {
        method: 'POST',
        headers: tunnelHeaders(),
        body: JSON.stringify({ action: 'claim' }),
      },
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
      {
        method: 'POST',
        headers: tunnelHeaders({ 'Sec-Fetch-Site': 'cross-site' }),
        body: JSON.stringify({ action: 'claim' }),
      },
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
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: SESSION_COOKIE,
          ...CF_HEADER,
        },
        body: JSON.stringify({ action: 'claim' }),
      },
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
        {
          method,
          headers: { 'Content-Type': 'application/json', ...CF_HEADER },
          body: method === 'DELETE' ? undefined : '{}',
        },
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
      { headers: CF_HEADER },
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
  });
});
