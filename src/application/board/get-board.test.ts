import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import {
  makeSession,
  makeSessionLink,
  makeTicket,
} from '../../domain/test-support.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { PendingDecision } from '../ports/human-decisions.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import { getBoard } from './get-board.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

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
    readonly pendingDecisions?: readonly PendingDecision[];
  }[],
): void {
  for (const item of items) {
    cache.putProject({
      project: item.project,
      tickets: [makeTicket({ id: item.ticketId, projectId: item.project.id })],
      fingerprint: `fp-${item.project.id}`,
      fetchedAt: NOW,
      ...(item.pendingDecisions !== undefined ? { pendingDecisions: item.pendingDecisions } : {}),
    });
  }
}

describe('getBoard', () => {
  it('filters each project to an epic subtree before building the board', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'epic', projectId: a.id }),
        makeTicket({ id: 'child', projectId: a.id, parentId: 'epic' }),
        makeTicket({ id: 'grandchild', projectId: a.id, parentId: 'child' }),
        makeTicket({ id: 'unrelated', projectId: a.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const view = await getBoard({ cache, now: NOW }, { epicId: 'epic' });

    expect(view.merged?.cards.map((card) => card.ticket.id).sort()).toEqual([
      'epic',
      'child',
      'grandchild',
    ].sort());
  });

  it('keeps an epic-subtree child blocked (with blockedBy) when blocked by a ticket outside the epic (bdboard-3tw.95 review M1)', async () => {
    // Regression: filtering the ticket list down to the epic subtree *before*
    // buildBoard used to make readiness/openBlockerIds treat the out-of-subtree
    // blocker as an unknown ticket and silently drop it, flipping the blocked
    // child to 'ready'. buildBoard must always run over the full project ticket
    // set; the epicId scope is applied to the resulting cards afterward.
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'epic', projectId: a.id }),
        makeTicket({
          id: 'child',
          projectId: a.id,
          parentId: 'epic',
          dependencies: [
            { issueId: 'child', dependsOnId: 'external', kind: 'blocks' },
          ],
        }),
        // 'external' is deliberately outside the epic subtree (no parentId,
        // not a descendant) — it must not appear on the scoped board, but its
        // still-open status must still count toward child's blocked lane.
        makeTicket({ id: 'external', projectId: a.id, status: 'open' }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const view = await getBoard({ cache, now: NOW }, { epicId: 'epic' });

    const cardIds = (view.merged?.cards ?? []).map((card) => card.ticket.id);
    expect(cardIds.sort()).toEqual(['child', 'epic'].sort());

    const childCard = view.merged?.cards.find((card) => card.ticket.id === 'child');
    expect(childCard?.lane).toBe('blocked');
    expect(childCard?.blockedBy).toEqual(['external']);
    expect(view.merged?.lanes.blocked.map((card) => card.ticket.id)).toEqual(['child']);
    // The epic itself has no blockers of its own, so it legitimately stays in
    // 'ready' — only 'child' (blocked by the out-of-subtree 'external' ticket)
    // must be excluded from 'ready'.
    expect(view.merged?.lanes.ready.map((card) => card.ticket.id)).toEqual(['epic']);
  });

  it('returns an empty scoped board for an unknown epicId (contract)', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'epic', projectId: a.id }),
        makeTicket({ id: 'child', projectId: a.id, parentId: 'epic' }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const view = await getBoard({ cache, now: NOW }, { epicId: 'bdboard-does-not-exist' });

    expect(view.merged?.cards).toEqual([]);
    expect(view.merged?.lanes.ready).toEqual([]);
    expect(view.merged?.lanes.blocked).toEqual([]);
    expect(view.merged?.lanes.done).toEqual([]);
  });

  it('filters projects by projectIds', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const view = await getBoard({ cache, now: NOW }, { projectIds: [b.id] });

    expect(view.projects.map((p) => p.project.id)).toEqual([b.id]);
    expect(view.projects[0]?.board.cards[0]?.ticket.id).toBe('bdboard-b');
  });

  it('merges all project cards when mode is merged', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const view = await getBoard({ cache, now: NOW }, { mode: 'merged' });

    expect(view.merged).not.toBeNull();
    expect(view.merged?.cards.map((card) => card.ticket.id).sort()).toEqual([
      'bdboard-a',
      'bdboard-b',
    ]);
  });

  it('returns null merged board when mode is split', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const view = await getBoard({ cache, now: NOW }, { mode: 'split' });

    expect(view.merged).toBeNull();
    expect(view.projects).toHaveLength(1);
  });

  it('defaults mode to merged when not specified', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const view = await getBoard({ cache, now: NOW });

    expect(view.mode).toBe('merged');
    expect(view.merged).not.toBeNull();
  });

  it('returns empty projects and empty merged board when cache is empty', async () => {
    const cache = createFakeBoardCache();
    const view = await getBoard({ cache, now: NOW });

    expect(view.projects).toEqual([]);
    expect(view.merged?.cards).toEqual([]);
  });

  it('orders projects by rootPath ascending', async () => {
    const cache = createFakeBoardCache();
    const z = project('/z', '/projects/z');
    const a = project('/a', '/projects/a');
    const m = project('/m', '/projects/m');
    seedCache(cache, [
      { project: z, ticketId: 'bdboard-z' },
      { project: a, ticketId: 'bdboard-a' },
      { project: m, ticketId: 'bdboard-m' },
    ]);

    const view = await getBoard({ cache, now: NOW });

    expect(view.projects.map((p) => p.project.rootPath)).toEqual([
      '/projects/a',
      '/projects/m',
      '/projects/z',
    ]);
  });

  it('ignores unknown projectIds without throwing', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const view = await getBoard({ cache, now: NOW }, { projectIds: [a.id, '/missing'] });

    expect(view.projects.map((p) => p.project.id)).toEqual([a.id]);
  });

  it('passes sessions and links to buildBoard', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-linked' }]);

    const session = makeSession({
      sessionId: 'session-active',
      lastActivityAt: NOW,
      alive: true,
    });
    const links = [
      makeSessionLink({ ticketId: 'bdboard-linked', sessionId: 'session-active' }),
    ];
    /*
     * ここで livenessThresholds を渡さないのは意図的 (bdboard-3z5x)。この
     * テストが見ているのは sessions/links の受け渡しであって閾値ではなく、
     * lastActivityAt=NOW は既定閾値でも上書き閾値でも 'active' になるため、
     * 閾値を渡しても何も検証できない (渡し忘れても通る飾りになる)。
     * 閾値の受け渡しは下の 'passes livenessThresholds to buildBoard' が見る。
     */
    const view = await getBoard({
      cache,
      now: NOW,
      sessions: [session],
      links,
    });

    const card = view.projects[0]?.board.cards[0];
    expect(card?.sessions.map((s) => s.sessionId)).toEqual(['session-active']);
    expect(card?.liveness).toBe('active');
  });

  it('passes livenessThresholds to buildBoard', async () => {
    /*
     * 既定 (activeMs=5分) と上書き (activeMs=1分) で結果が変わる入力を使う。
     * 2分アイドルなら既定は 'active'、上書きは 'idle'。この対比が無いと
     * get-board.ts の条件付き spread から livenessThresholds を落としても
     * このファイルは緑のまま通る (bdboard-3z5x で変異テストにより確認)。
     * 隣の stalledThresholds は既にこの形で守られており、それに揃えた。
     */
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-liveness' }]);
    const session = makeSession({
      sessionId: 'session-2m-idle',
      lastActivityAt: new Date(NOW.getTime() - 2 * 60_000),
      alive: true,
    });
    const links = [
      makeSessionLink({ ticketId: 'bdboard-liveness', sessionId: 'session-2m-idle' }),
    ];

    const defaultView = await getBoard({ cache, now: NOW, sessions: [session], links });
    expect(defaultView.projects[0]?.board.cards[0]?.liveness).toBe('active');

    const overriddenView = await getBoard({
      cache,
      now: NOW,
      sessions: [session],
      links,
      livenessThresholds: {
        activeMs: 60_000,
        idleMs: 10 * 60_000,
        staleMs: 60 * 60_000,
      },
    });
    expect(overriddenView.projects[0]?.board.cards[0]?.liveness).toBe('idle');
  });

  it('passes stalledThresholds to buildBoard', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const oldUpdatedAt = new Date(NOW.getTime() - 3 * 60 * 60_000);
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-stalled',
          projectId: a.id,
          status: 'in_progress',
          updatedAt: oldUpdatedAt,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const shortThresholdView = await getBoard({
      cache,
      now: NOW,
      stalledThresholds: { stalledAfterMs: 60 * 60_000 },
    });
    expect(
      shortThresholdView.projects[0]?.board.cards.find((card) => card.ticket.id === 'bdboard-stalled')
        ?.stalled,
    ).toBe(true);

    const longThresholdView = await getBoard({
      cache,
      now: NOW,
      stalledThresholds: { stalledAfterMs: 24 * 60 * 60_000 },
    });
    expect(
      longThresholdView.projects[0]?.board.cards.find((card) => card.ticket.id === 'bdboard-stalled')
        ?.stalled,
    ).toBe(false);
  });

  it('sets generatedAt from deps.now', async () => {
    const cache = createFakeBoardCache();
    const view = await getBoard({ cache, now: NOW });

    expect(view.generatedAt).toBe(NOW);
  });

  describe('human decisions (awaiting_human lane)', () => {
    it('routes a human-labeled ticket to awaiting_human from cached pendingDecisions', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      seedCache(cache, [
        {
          project: a,
          ticketId: 'bdboard-waiting',
          pendingDecisions: [{ id: 'bdboard-waiting', kind: 'ticket', allowFreeform: true }],
        },
      ]);

      const view = await getBoard({ cache, now: NOW });

      const board = view.projects[0]?.board;
      expect(board?.lanes.awaiting_human.map((c) => c.ticket.id)).toEqual([
        'bdboard-waiting',
      ]);
      expect(board?.lanes.ready).toEqual([]);
      expect(view.merged?.lanes.awaiting_human.map((c) => c.ticket.id)).toEqual([
        'bdboard-waiting',
      ]);
      expect(view.merged?.lanes.ready).toEqual([]);
    });

    it('keeps tickets in their normal lane when pendingDecisions is not cached', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      seedCache(cache, [{ project: a, ticketId: 'bdboard-plain' }]);

      const view = await getBoard({ cache, now: NOW });

      const board = view.projects[0]?.board;
      expect(board?.lanes.awaiting_human).toEqual([]);
      expect(board?.lanes.ready.map((c) => c.ticket.id)).toEqual(['bdboard-plain']);
    });

    it('keeps awaiting_human empty when cached pending decisions list is empty', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      cache.putProject({
        project: a,
        tickets: [makeTicket({ id: 'bdboard-plain', projectId: a.id })],
        fingerprint: 'fp-a',
        fetchedAt: NOW,
        pendingDecisions: [],
      });

      const view = await getBoard({ cache, now: NOW });

      const board = view.projects[0]?.board;
      expect(board?.lanes.awaiting_human).toEqual([]);
      expect(board?.lanes.ready.map((c) => c.ticket.id)).toEqual(['bdboard-plain']);
    });

    it('does not invoke bd shellouts or human decision ports', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      seedCache(cache, [{ project: a, ticketId: 'bdboard-plain' }]);

      const deps = { cache, now: NOW };
      expect('humanDecisions' in deps).toBe(false);

      const view = await getBoard(deps);

      expect(view.projects).toHaveLength(1);
    });
  });

  describe('closedLimit (done lane truncation, bdboard-3tw.86)', () => {
    function closedTicket(id: string, closedAt: Date, projectId: string) {
      return makeTicket({
        id,
        projectId,
        status: 'closed',
        closedAt,
        updatedAt: closedAt,
      });
    }

    it('keeps every closed ticket when the total is within closedLimit', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      cache.putProject({
        project: a,
        tickets: [
          closedTicket('bdboard-c1', new Date('2026-05-01T00:00:00.000Z'), a.id),
          closedTicket('bdboard-c2', new Date('2026-05-02T00:00:00.000Z'), a.id),
        ],
        fingerprint: 'fp-a',
        fetchedAt: NOW,
      });

      const view = await getBoard({ cache, now: NOW }, { closedLimit: 5 });

      expect(view.projects[0]?.board.lanes.done).toHaveLength(2);
      expect(view.projects[0]?.closedTotal).toBe(2);
      expect(view.projects[0]?.truncatedClosedIds).toEqual([]);
    });

    it('truncates the done lane to closedLimit, keeping the most recently closed', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      const tickets = [
        closedTicket('bdboard-old', new Date('2026-01-01T00:00:00.000Z'), a.id),
        closedTicket('bdboard-mid', new Date('2026-03-01T00:00:00.000Z'), a.id),
        closedTicket('bdboard-new', new Date('2026-05-01T00:00:00.000Z'), a.id),
      ];
      cache.putProject({
        project: a,
        tickets,
        fingerprint: 'fp-a',
        fetchedAt: NOW,
      });

      const view = await getBoard({ cache, now: NOW }, { closedLimit: 2 });

      const board = view.projects[0]?.board;
      expect(board?.lanes.done.map((c) => c.ticket.id)).toEqual([
        'bdboard-new',
        'bdboard-mid',
      ]);
      expect(view.projects[0]?.closedTotal).toBe(3);
      // 切り捨てた分は board.cards からも消えて cardCount と整合する
      expect(board?.cards.some((c) => c.ticket.id === 'bdboard-old')).toBe(false);
      expect(board?.cards).toHaveLength(2);
      // load-bearing (bdboard-3tw.86 追補, 議長レビュー指摘): カードは消えても
      // IDだけは truncatedClosedIds として残り、既知ID自動リンク(bdboard-3tw.64)が
      // 参照を解決できるようにする。
      expect(view.projects[0]?.truncatedClosedIds).toEqual(['bdboard-old']);
    });

    it('does not truncate when closedLimit is not specified', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      const tickets = [
        closedTicket('bdboard-c0', new Date('2026-01-01T00:00:00.000Z'), a.id),
        closedTicket('bdboard-c1', new Date('2026-01-02T00:00:00.000Z'), a.id),
        closedTicket('bdboard-c2', new Date('2026-01-03T00:00:00.000Z'), a.id),
        closedTicket('bdboard-c3', new Date('2026-01-04T00:00:00.000Z'), a.id),
        closedTicket('bdboard-c4', new Date('2026-01-05T00:00:00.000Z'), a.id),
      ];
      cache.putProject({ project: a, tickets, fingerprint: 'fp-a', fetchedAt: NOW });

      const view = await getBoard({ cache, now: NOW });

      expect(view.projects[0]?.board.lanes.done).toHaveLength(5);
      expect(view.projects[0]?.closedTotal).toBe(5);
      expect(view.projects[0]?.truncatedClosedIds).toEqual([]);
    });

    it('aggregates mergedClosedTotal across projects in merged mode', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      const b = project('proj-b', '/projects/b');
      cache.putProject({
        project: a,
        tickets: [
          closedTicket('bdboard-a1', new Date('2026-01-01T00:00:00.000Z'), a.id),
          closedTicket('bdboard-a2', new Date('2026-01-02T00:00:00.000Z'), a.id),
        ],
        fingerprint: 'fp-a',
        fetchedAt: NOW,
      });
      cache.putProject({
        project: b,
        tickets: [
          closedTicket('bdboard-b1', new Date('2026-01-03T00:00:00.000Z'), b.id),
        ],
        fingerprint: 'fp-b',
        fetchedAt: NOW,
      });

      const view = await getBoard(
        { cache, now: NOW },
        { closedLimit: 1, mode: 'merged' },
      );

      expect(view.mergedClosedTotal).toBe(3);
      // 1件/プロジェクト上限 × 2プロジェクト分がmergedのdoneレーンに残る
      expect(view.merged?.lanes.done).toHaveLength(2);
      // proj-a は2件中1件切り捨て(bdboard-a1)、proj-b は1件のみで切り捨てなし。
      // mergedTruncatedClosedIds はプロジェクト横断で集約されたID一覧になる。
      expect(view.mergedTruncatedClosedIds).toEqual(['bdboard-a1']);
    });

    it('leaves mergedClosedTotal null in split mode', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      cache.putProject({
        project: a,
        tickets: [
          closedTicket('bdboard-a1', new Date('2026-01-01T00:00:00.000Z'), a.id),
        ],
        fingerprint: 'fp-a',
        fetchedAt: NOW,
      });

      const view = await getBoard({ cache, now: NOW }, { mode: 'split' });

      expect(view.mergedClosedTotal).toBeNull();
      expect(view.merged).toBeNull();
      expect(view.mergedTruncatedClosedIds).toBeNull();
    });
  });

  it('passes timeZone to buildBoard for defer-day truncation', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const now = new Date('2026-06-01T15:00:00.000Z');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-defer-tz',
          projectId: a.id,
          status: 'deferred',
          deferUntil: new Date('2026-06-08T00:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });

    const utcView = await getBoard({ cache, now }, { timeZone: 'UTC' });
    const tokyoView = await getBoard({ cache, now }, { timeZone: 'Asia/Tokyo' });

    const utcCard = utcView.projects[0]?.board.cards[0];
    const tokyoCard = tokyoView.projects[0]?.board.cards[0];

    expect(utcCard?.deferDays).toBe(7);
    expect(tokyoCard?.deferDays).toBe(6);
  });
});
