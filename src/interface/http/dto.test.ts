import { describe, expect, it } from 'vitest';
import { buildBoard } from '../../domain/board.js';
import { LANES } from '../../domain/readiness.js';
import { makeSession, makeTicket } from '../../domain/test-support.js';
import type { BoardView } from '../../application/board/get-board.js';
import {
  toBoardCardDto,
  toBoardDto,
  toBoardViewDto,
  toActivityEventDto,
  toMergeSlotStatusDto,
  toProjectDto,
  toSessionDto,
  toTicketDetailDto,
  toTicketSummaryDto,
  toTicketTokenUsageDto,
} from './dto.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function assertNoDates(value: unknown): void {
  if (value instanceof Date) {
    throw new Error('Found Date instance in DTO');
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

describe('dto', () => {
  it('converts all Date fields to ISO strings', () => {
    const ticket = makeTicket({
      startedAt: NOW,
      closedAt: NOW,
      deferUntil: NOW,
    });
    const session = makeSession({ lastActivityAt: NOW, startedAt: NOW });
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [ticket],
      now: NOW,
      sessions: [session],
      links: [
        {
          ticketId: ticket.id,
          sessionId: session.sessionId,
          source: 'metadata',
          confidence: 1,
          observedAt: NOW,
        },
      ],
    });

    const view: BoardView = {
      mode: 'merged',
      generatedAt: NOW,
      projects: [
        {
          project: {
            id: '/projects/a',
            name: 'a',
            rootPath: '/projects/a',
            prefixes: ['bdboard'],
            aliasPaths: [],
          },
          board,
          closedTotal: board.lanes.done.length,
          truncatedClosedIds: [],
        },
      ],
      merged: board,
      mergedClosedTotal: board.lanes.done.length,
      mergedTruncatedClosedIds: [],
    };

    const dto = toBoardViewDto(view);
    assertNoDates(dto);
    expect(dto.generatedAt).toBe(NOW.toISOString());
  });

  it('includes stalled on BoardCardDto', () => {
    const stalledTicket = makeTicket({
      id: 'bdboard-stalled-dto',
      status: 'in_progress',
      updatedAt: new Date(NOW.getTime() - 48 * 60 * 60_000),
    });
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [stalledTicket],
      now: NOW,
    });
    const card = board.cards[0];

    const dto = toBoardCardDto(card, NOW);

    expect(dto.stalled).toBe(true);
  });

  it('includes epicProgress and defer fields on BoardCardDto', () => {
    const epic = makeTicket({ id: 'bdboard-epic-dto' });
    const child = makeTicket({
      id: 'bdboard-child-dto',
      parentId: 'bdboard-epic-dto',
      status: 'closed',
    });
    const deferred = makeTicket({
      id: 'bdboard-defer-dto',
      status: 'deferred',
      deferUntil: new Date('2026-06-04T00:00:00.000Z'),
    });
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [epic, child, deferred],
      now: NOW,
    });

    const epicDto = toBoardCardDto(
      board.cards.find((c) => c.ticket.id === 'bdboard-epic-dto')!,
      NOW,
    );
    const deferDto = toBoardCardDto(
      board.cards.find((c) => c.ticket.id === 'bdboard-defer-dto')!,
      NOW,
    );

    expect(epicDto.epicProgress).toEqual({ total: 1, done: 1 });
    expect(deferDto.deferDays).toBe(3);
    expect(deferDto.deferUrgency).toBe('soon');
  });

  it('includes effectivePriority fields on BoardCardDto', () => {
    const blocker = makeTicket({
      id: 'bdboard-dto-blocker',
      status: 'open',
      priority: 3,
      dependencies: [],
    });
    const blocked = makeTicket({
      id: 'bdboard-dto-blocked',
      status: 'open',
      priority: 0,
      dependencies: [
        {
          issueId: 'bdboard-dto-blocked',
          dependsOnId: 'bdboard-dto-blocker',
          kind: 'blocks',
        },
      ],
    });
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [blocker, blocked],
      now: NOW,
    });
    const blockerCard = board.cards.find(
      (c) => c.ticket.id === 'bdboard-dto-blocker',
    )!;

    const dto = toBoardCardDto(blockerCard, NOW);

    expect(dto.effectivePriority).toBe(0);
    expect(dto.priorityInheritedFrom).toBe('bdboard-dto-blocked');
  });

  it('includes every lane key in BoardDto', () => {
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [makeTicket()],
      now: NOW,
    });

    const dto = toBoardDto(board, NOW);

    for (const lane of LANES) {
      expect(lane in dto.lanes).toBe(true);
      expect(Array.isArray(dto.lanes[lane])).toBe(true);
    }
    expect(dto.cardCount).toBe(1);
  });

  it('defaults BoardDto.closedTotal to the done lane length when not overridden', () => {
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [makeTicket({ status: 'closed', closedAt: NOW })],
      now: NOW,
    });

    const dto = toBoardDto(board, NOW);

    expect(dto.closedTotal).toBe(1);
  });

  it('uses the explicit closedTotal override when provided (post-closedLimit truncation)', () => {
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [makeTicket({ status: 'closed', closedAt: NOW })],
      now: NOW,
    });

    // 呼び出し元(getBoard)がclosedLimitで切った後、切る前の総件数を渡すケースを模す
    const dto = toBoardDto(board, NOW, 42);

    expect(dto.lanes.done).toHaveLength(1);
    expect(dto.closedTotal).toBe(42);
  });

  it('defaults BoardDto.truncatedClosedIds to an empty array when not provided', () => {
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [makeTicket({ status: 'closed', closedAt: NOW })],
      now: NOW,
    });

    const dto = toBoardDto(board, NOW);

    expect(dto.truncatedClosedIds).toEqual([]);
  });

  it('carries the explicit truncatedClosedIds override through to the wire DTO', () => {
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [makeTicket({ status: 'closed', closedAt: NOW })],
      now: NOW,
    });

    // 呼び出し元(getBoard)がcloseLimitで切り捨てたIDを渡すケースを模す
    const dto = toBoardDto(board, NOW, 42, ['bdboard-old-1', 'bdboard-old-2']);

    expect(dto.truncatedClosedIds).toEqual(['bdboard-old-1', 'bdboard-old-2']);
  });

  describe('toBoardViewDto merged-mode dedup (bdboard-3tw.86)', () => {
    function makeView(mode: 'merged' | 'split'): BoardView {
      const ticket = makeTicket({ id: 'bdboard-dedup', projectId: '/projects/a' });
      const board = buildBoard({
        projectId: '/projects/a',
        tickets: [ticket],
        now: NOW,
      });
      const projectDto = {
        id: '/projects/a',
        name: 'a',
        rootPath: '/projects/a',
        prefixes: ['bdboard'],
        aliasPaths: [],
      };

      return {
        mode,
        generatedAt: NOW,
        projects: [{ project: projectDto, board, closedTotal: 0, truncatedClosedIds: [] }],
        merged: mode === 'merged' ? board : null,
        mergedClosedTotal: mode === 'merged' ? 0 : null,
        mergedTruncatedClosedIds: mode === 'merged' ? [] : null,
      };
    }

    it('empties projects in merged mode so tickets are not sent twice', () => {
      const dto = toBoardViewDto(makeView('merged'));

      expect(dto.projects).toEqual([]);
      expect(dto.merged?.lanes.ready.map((c) => c.ticket.id)).toEqual([
        'bdboard-dedup',
      ]);
    });

    it('keeps projects populated in split mode', () => {
      const dto = toBoardViewDto(makeView('split'));

      expect(dto.projects).toHaveLength(1);
      expect(
        dto.projects[0]?.board.lanes.ready.map((c) => c.ticket.id),
      ).toEqual(['bdboard-dedup']);
      expect(dto.merged).toBeNull();
    });

    // load-bearing (bdboard-3tw.86 追補, 議長レビュー指摘): closedLimitで切り捨てた
    // チケットIDが merged.truncatedClosedIds として実際に /api/board のワイヤーDTOへ
    // 出ていることを固定する。既知ID自動リンク(bdboard-3tw.64)側の boardTicketIds は
    // このフィールドを読むので、ここが壊れるとリンクも壊れる。
    it('carries mergedTruncatedClosedIds through to merged.truncatedClosedIds on the wire', () => {
      const view = makeView('merged');
      const viewWithTruncation: BoardView = {
        ...view,
        mergedTruncatedClosedIds: ['bdboard-old-1', 'bdboard-old-2'],
      };

      const dto = toBoardViewDto(viewWithTruncation);

      expect(dto.merged?.truncatedClosedIds).toEqual(['bdboard-old-1', 'bdboard-old-2']);
    });

    it('carries per-project truncatedClosedIds through in split mode', () => {
      const view = makeView('split');
      const viewWithTruncation: BoardView = {
        ...view,
        projects: view.projects.map((p) => ({
          ...p,
          truncatedClosedIds: ['bdboard-old-3'],
        })),
      };

      const dto = toBoardViewDto(viewWithTruncation);

      expect(dto.projects[0]?.board.truncatedClosedIds).toEqual(['bdboard-old-3']);
    });
  });

  it('measures the /api/board payload size reduction from bdboard-3tw.86 (merged dedup + closedLimit)', () => {
    const CLOSED_COUNT = 400;
    const OPEN_COUNT = 40;

    const closedTickets = Array.from({ length: CLOSED_COUNT }, (_, i) =>
      makeTicket({
        id: `bdboard-closed-${i}`,
        projectId: '/projects/a',
        status: 'closed',
        closedAt: new Date(NOW.getTime() - i * 60_000),
        updatedAt: new Date(NOW.getTime() - i * 60_000),
      }),
    );
    const openTickets = Array.from({ length: OPEN_COUNT }, (_, i) =>
      makeTicket({ id: `bdboard-open-${i}`, projectId: '/projects/a' }),
    );
    const tickets = [...closedTickets, ...openTickets];

    const projectDto = {
      id: '/projects/a',
      name: 'a',
      rootPath: '/projects/a',
      prefixes: ['bdboard'],
      aliasPaths: [],
    };

    // "before" bdboard-3tw.86: mergedモードでも projects がフルに埋まり(全チケットが
    // projects側とmerged側に二重送信)、doneレーンにも上限が無かった(素のbuildBoard結果
    // をそのまま両方にシリアライズしていた挙動を再現)。
    const fullBoard = buildBoard({
      projectId: '/projects/a',
      tickets,
      now: NOW,
    });
    const beforeDto = {
      mode: 'merged',
      generatedAt: NOW.toISOString(),
      projects: [{ project: projectDto, board: toBoardDto(fullBoard, NOW) }],
      merged: toBoardDto(fullBoard, NOW),
    };
    const beforeSize = JSON.stringify(beforeDto).length;

    // "after": get-board.ts の closedLimit で切ってから toBoardViewDto に通す。
    const CLOSED_LIMIT = 100;
    const truncatedDoneCards = [...fullBoard.lanes.done]
      .sort((a, b) => (b.ticket.closedAt?.getTime() ?? 0) - (a.ticket.closedAt?.getTime() ?? 0))
      .slice(0, CLOSED_LIMIT);
    const truncatedIds = new Set(truncatedDoneCards.map((c) => c.ticket.id));
    const truncatedBoard = {
      cards: fullBoard.cards.filter(
        (c) => c.lane !== 'done' || truncatedIds.has(c.ticket.id),
      ),
      lanes: { ...fullBoard.lanes, done: truncatedDoneCards },
    };
    const truncatedClosedIds = [...fullBoard.lanes.done]
      .sort((a, b) => (b.ticket.closedAt?.getTime() ?? 0) - (a.ticket.closedAt?.getTime() ?? 0))
      .slice(CLOSED_LIMIT)
      .map((c) => c.ticket.id);
    const afterView: BoardView = {
      mode: 'merged',
      generatedAt: NOW,
      projects: [
        {
          project: projectDto,
          board: truncatedBoard,
          closedTotal: CLOSED_COUNT,
          truncatedClosedIds,
        },
      ],
      merged: truncatedBoard,
      mergedClosedTotal: CLOSED_COUNT,
      mergedTruncatedClosedIds: truncatedClosedIds,
    };
    const afterDto = toBoardViewDto(afterView);
    const afterSize = JSON.stringify(afterDto).length;

    // 削減効果を数値でログに残す(議長のレビュー用。bdboard-3tw.86)。
    // eslint-disable-next-line no-console
    console.log(
      `[bdboard-3tw.86] payload size before=${beforeSize}B after=${afterSize}B ` +
        `reduction=${(((beforeSize - afterSize) / beforeSize) * 100).toFixed(1)}%`,
    );

    expect(afterDto.projects).toEqual([]);
    expect(afterSize).toBeLessThan(beforeSize);
    // 二重送信の解消(projectsを空に)とdoneレーンの400→100件への切り捨てを合わせ、
    // 半分以上は縮む規模になっていることを保証する(退行検知の閾値)。
    expect(afterSize).toBeLessThan(beforeSize * 0.5);

    // bdboard-3tw.86 追補(議長レビュー): 切り捨てられた300件のIDは card ではなく
    // truncatedClosedIds として載る。既知ID自動リンク(bdboard-3tw.64)がこれらを
    // 「ボード上に存在する」と扱えるように、IDだけは失われていないことを固定する。
    expect(afterDto.merged?.truncatedClosedIds).toHaveLength(CLOSED_COUNT - CLOSED_LIMIT);
    // ID一覧を積んでもなお、カード全体を送るより桁違いに小さいことを確認する。
    expect(afterSize).toBeLessThan(beforeSize * 0.2);
  });

  it('omits optional fields when values are absent', () => {
    const dto = toTicketSummaryDto(makeTicket());

    expect('startedAt' in dto).toBe(false);
    expect('closedAt' in dto).toBe(false);
    expect('deferUntil' in dto).toBe(false);
    expect('assignee' in dto).toBe(false);
    expect('owner' in dto).toBe(false);
    expect('parentId' in dto).toBe(false);
    expect('labels' in dto).toBe(false);
  });

  it('includes labels on TicketSummaryDto and BoardCardDto', () => {
    const ticket = makeTicket({
      labels: ['human', 'needs-review'],
    });
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [ticket],
      now: NOW,
    });
    const card = board.cards[0]!;

    const summary = toTicketSummaryDto(ticket);
    expect(summary.labels).toEqual(['human', 'needs-review']);

    const cardDto = toBoardCardDto(card, NOW);
    expect(cardDto.ticket.labels).toEqual(['human', 'needs-review']);
  });

  it('includes ticket detail fields from BoardCard', () => {
    const ticket = makeTicket({
      id: 'bdboard-detail',
      description: 'detail body',
      notes: 'note body',
      dependencies: [
        {
          issueId: 'bdboard-detail',
          dependsOnId: 'bdboard-blocker',
          kind: 'blocks',
        },
      ],
    });
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [ticket, makeTicket({ id: 'bdboard-blocker' })],
      now: NOW,
    });
    const card = board.cards.find((entry) => entry.ticket.id === 'bdboard-detail');
    expect(card).toBeDefined();

    const dto = toTicketDetailDto(card!, [], [], [
      { id: 'bdboard-child', title: 'Child ticket', lane: 'in_progress' },
    ]);

    expect(dto.description).toBe('detail body');
    expect(dto.notes).toBe('note body');
    expect(dto.dependencies).toEqual([
      {
        issueId: 'bdboard-detail',
        dependsOnId: 'bdboard-blocker',
        kind: 'blocks',
      },
    ]);
    // bdboard-blocker is still open, so it blocks bdboard-detail.
    expect(dto.blockedBy).toEqual(['bdboard-blocker']);
    // Nothing depends on bdboard-detail, so it blocks nothing.
    expect(dto.blocks).toEqual([]);
    expect(dto.models).toEqual([]);
    expect(dto.children).toEqual([
      { id: 'bdboard-child', title: 'Child ticket', lane: 'in_progress' },
    ]);
  });

  it('maps ticket token usage totals to dto', () => {
    const dto = toTicketTokenUsageDto({
      ticketId: 'bdboard-detail',
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

    expect(dto).toEqual({
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

  it('omits optional session name when absent', () => {
    const dto = toSessionDto(
      makeSession({ startedAt: NOW, lastActivityAt: NOW }),
      NOW,
    );

    expect('name' in dto).toBe(false);
    expect(dto.startedAt).toBe(NOW.toISOString());
    expect(dto.liveness).toBe('active');
  });

  it('toSessionDto returns liveness based on now and lastActivityAt', () => {
    const recent = makeSession({
      alive: true,
      lastActivityAt: NOW,
    });
    const idle = makeSession({
      alive: true,
      lastActivityAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    const stale = makeSession({
      alive: true,
      lastActivityAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    });
    const dormant = makeSession({
      alive: false,
      lastActivityAt: NOW,
    });

    expect(toSessionDto(recent, NOW).liveness).toBe('active');
    expect(toSessionDto(idle, NOW).liveness).toBe('idle');
    expect(toSessionDto(stale, NOW).liveness).toBe('stale');
    expect(toSessionDto(dormant, NOW).liveness).toBe('dormant');
  });

  it('toProjectDto without sessions returns empty sessions and zero counts', () => {
    const project = {
      id: '/projects/a',
      name: 'a',
      rootPath: '/projects/a',
      prefixes: ['bdboard'],
      aliasPaths: [],
    };

    const dto = toProjectDto(project, NOW);

    expect(dto.sessionCount).toBe(0);
    expect(dto.activeSessionCount).toBe(0);
    expect(dto.sessions).toEqual([]);
    expect(Object.keys(dto)).not.toContain('aliasPaths');
  });

  it('toProjectDto counts liveness active sessions and preserves order', () => {
    const project = {
      id: '/projects/a',
      name: 'a',
      rootPath: '/projects/a',
      prefixes: ['bdboard'],
      aliasPaths: [],
    };
    const activeSession = makeSession({
      sessionId: 'session-active',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const idleSession = makeSession({
      sessionId: 'session-idle',
      alive: true,
      startedAt: NOW,
      lastActivityAt: new Date(NOW.getTime() - 30 * 60_000),
    });
    const staleSession = makeSession({
      sessionId: 'session-stale',
      alive: true,
      startedAt: NOW,
      lastActivityAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    const dormantSession = makeSession({
      sessionId: 'session-dormant',
      alive: false,
      startedAt: NOW,
      lastActivityAt: NOW,
    });

    const dto = toProjectDto(
      project,
      NOW,
      [activeSession, idleSession, staleSession, dormantSession],
    );

    expect(dto.sessionCount).toBe(4);
    expect(dto.activeSessionCount).toBe(1);
    expect(dto.sessions).toHaveLength(4);
    expect(dto.sessions[0]?.sessionId).toBe('session-active');
    expect(dto.sessions[1]?.sessionId).toBe('session-idle');
    expect(dto.sessions[2]?.sessionId).toBe('session-stale');
    expect(dto.sessions[3]?.sessionId).toBe('session-dormant');
  });

  it('toProjectDto does not count alive-but-stale sessions as active', () => {
    const project = {
      id: '/projects/a',
      name: 'a',
      rootPath: '/projects/a',
      prefixes: ['bdboard'],
      aliasPaths: [],
    };
    const staleButAlive = makeSession({
      sessionId: 'session-stale-alive',
      alive: true,
      startedAt: NOW,
      lastActivityAt: new Date(NOW.getTime() - 60 * 60_000),
    });

    const dto = toProjectDto(project, NOW, [staleButAlive]);

    expect(dto.sessionCount).toBe(1);
    expect(dto.activeSessionCount).toBe(0);
    expect(dto.sessions[0]?.liveness).toBe('stale');
  });

  it('toBoardViewDto includes activeSessionCount from sessionsByProject map', () => {
    const ticket = makeTicket();
    const board = buildBoard({
      projectId: '/projects/a',
      tickets: [ticket],
      now: NOW,
    });
    const project = {
      id: '/projects/a',
      name: 'a',
      rootPath: '/projects/a',
      prefixes: ['bdboard'],
      aliasPaths: [],
    };
    const view: BoardView = {
      mode: 'split',
      generatedAt: NOW,
      projects: [
        { project, board, closedTotal: board.lanes.done.length, truncatedClosedIds: [] },
      ],
      merged: null,
      mergedClosedTotal: null,
      mergedTruncatedClosedIds: null,
    };
    const aliveSession = makeSession({
      sessionId: 'session-alive',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const sessionsByProject = new Map<string, readonly typeof aliveSession[]>([
      [project.id, [aliveSession]],
    ]);

    const dto = toBoardViewDto(view, sessionsByProject);

    expect(dto.projects[0]?.project.activeSessionCount).toBe(1);
    expect(dto.projects[0]?.project.sessionCount).toBe(1);
    expect(dto.projects[0]?.project.sessions).toHaveLength(1);
    expect(dto.projects[0]?.project.sessions[0]?.liveness).toBe('active');
  });

  it('toActivityEventDto omits optional interaction fields when absent', () => {
    const project = {
      id: '/projects/a',
      name: 'a',
      rootPath: '/projects/a',
      prefixes: ['bdboard'],
      aliasPaths: [],
    };
    const ticket = makeTicket({
      id: 'bdboard-activity-dto',
      projectId: project.id,
      createdAt: NOW,
    });

    const dto = toActivityEventDto({
      kind: 'created',
      at: NOW,
      ticket,
      project,
    });

    expect(dto).toEqual({
      kind: 'created',
      at: NOW.toISOString(),
      id: ticket.id,
      projectId: project.id,
      projectName: project.name,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      issueType: ticket.issueType,
    });
    expect(dto).not.toHaveProperty('actor');
    expect(dto).not.toHaveProperty('reason');
    expect(dto).not.toHaveProperty('from');
    expect(dto).not.toHaveProperty('to');
  });

  it('toActivityEventDto includes optional interaction fields when present', () => {
    const project = {
      id: '/projects/a',
      name: 'a',
      rootPath: '/projects/a',
      prefixes: ['bdboard'],
      aliasPaths: [],
    };
    const ticket = makeTicket({
      id: 'bdboard-activity-enriched',
      projectId: project.id,
      closedAt: NOW,
    });

    const dto = toActivityEventDto({
      kind: 'closed',
      at: NOW,
      ticket,
      project,
      actor: 'example-agent',
      reason: 'example close reason',
      from: 'in_progress',
      to: 'closed',
    });

    expect(dto).toMatchObject({
      kind: 'closed',
      actor: 'example-agent',
      reason: 'example close reason',
      from: 'in_progress',
      to: 'closed',
    });
  });

  it('toActivityEventDto supports interaction-derived event kinds', () => {
    const project = {
      id: '/projects/a',
      name: 'a',
      rootPath: '/projects/a',
      prefixes: ['bdboard'],
      aliasPaths: [],
    };
    const ticket = makeTicket({
      id: 'bdboard-priority-dto',
      projectId: project.id,
    });

    const dto = toActivityEventDto({
      kind: 'priority_changed',
      at: NOW,
      ticket,
      project,
      actor: 'example-agent',
      from: '2',
      to: '1',
    });

    expect(dto.kind).toBe('priority_changed');
    expect(dto.from).toBe('2');
    expect(dto.to).toBe('1');
  });

  it('converts merge slot status to DTO', () => {
    const dto = toMergeSlotStatusDto({
      projectId: 'proj-a',
      present: true,
      held: true,
      holder: 'session-merge',
      heldSinceIso: '2026-08-17T10:47:14Z',
      heldForMs: 30 * 60_000,
      isLongHeld: false,
    });

    expect(dto).toEqual({
      projectId: 'proj-a',
      present: true,
      held: true,
      holder: 'session-merge',
      heldSinceIso: '2026-08-17T10:47:14Z',
      heldForMs: 30 * 60_000,
      isLongHeld: false,
    });
    assertNoDates(dto);
  });

  it('converts absent merge slot status to DTO', () => {
    const dto = toMergeSlotStatusDto({
      projectId: 'proj-b',
      present: false,
      held: false,
      holder: null,
      heldSinceIso: null,
      heldForMs: 0,
      isLongHeld: false,
    });

    expect(dto).toEqual({
      projectId: 'proj-b',
      present: false,
      held: false,
      holder: null,
      heldSinceIso: null,
      heldForMs: 0,
      isLongHeld: false,
    });
  });
});
