import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ActivityEventDto,
  BoardCardDto,
  BoardDto,
  PendingDecisionDto,
  SessionDto,
} from '../api';
import { projectNameFallback } from '../api';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import {
  buildDailyDigestMarkdown,
  type DailyDigestInput,
} from './dailyDigestMarkdown';

// bdboard-i759: 出力の時刻表記はboard timezoneに依存する。CIはUTC前提
// (Asia/Tokyo以外)なので、既存フィクスチャのJST前提の期待値を保つには
// 明示的にAsia/Tokyoへ固定する必要がある。
beforeEach(() => {
  setBoardTimeZoneOverride('Asia/Tokyo');
});

afterEach(() => {
  resetBoardTimeZoneForTests();
});

function makeEvent(
  overrides: Partial<ActivityEventDto> & Pick<ActivityEventDto, 'id' | 'kind' | 'at'>,
): ActivityEventDto {
  return {
    projectId: 'proj-1',
    projectName: 'Project One',
    title: 'Sample ticket',
    status: 'open',
    priority: 2,
    issueType: 'task',
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<SessionDto> & Pick<SessionDto, 'sessionId'>,
): SessionDto {
  return {
    pid: 1,
    cwd: '/tmp/work',
    alive: true,
    startedAt: '2026-08-15T00:00:00.000Z',
    lastActivityAt: '2026-08-15T01:00:00.000Z',
    liveness: 'idle',
    ...overrides,
  };
}

function makeCard(
  overrides: Partial<BoardCardDto> & Pick<BoardCardDto, 'ticket' | 'lane' | 'projectId'>,
): BoardCardDto {
  return {
    blockedBy: [],
    blocks: [],
    unblocksCount: 0,
    liveness: null,
    sessions: [],
    stalled: false,
    epicProgress: null,
    deferDays: null,
    deferUrgency: null,
    effectivePriority: overrides.ticket.priority,
    priorityInheritedFrom: null,
    ...overrides,
  };
}

function makeTicket(
  id: string,
  title: string,
  projectId: string,
  priority: number,
) {
  return {
    id,
    projectId,
    title,
    status: 'open',
    priority,
    issueType: 'task',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    commentCount: 0,
  };
}

function makeBoard(partial: Partial<Record<string, BoardCardDto[]>>): BoardDto {
  const lanes = {
    ready: partial.ready ?? [],
    in_progress: partial.in_progress ?? [],
    blocked: partial.blocked ?? [],
    done: partial.done ?? [],
  };
  const cardCount = Object.values(lanes).reduce((sum, cards) => sum + cards.length, 0);
  return { lanes, cardCount, closedTotal: lanes.done.length, truncatedClosedIds: [] };
}

function makeInput(overrides: Partial<DailyDigestInput> = {}): DailyDigestInput {
  return {
    now: new Date('2026-08-15T09:30:00+09:00'),
    windowDays: 1,
    activityEvents: [],
    board: null,
    pendingDecisions: [],
    projectNames: new Map<string, string>(),
    selectedProjectIds: [],
    ...overrides,
  };
}

describe('buildDailyDigestMarkdown', () => {
  it('renders all sections with the expected full markdown output', () => {
    const projectNames = new Map([
      ['proj-1', 'Project One'],
      ['proj-2', 'Project Two'],
    ]);

    const activityEvents = [
      makeEvent({
        id: 'bdboard-a',
        kind: 'closed',
        at: '2026-08-15T08:00:00+09:00',
        projectId: 'proj-1',
        title: 'やったこと',
        priority: 1,
      }),
      makeEvent({
        id: 'bdboard-b',
        kind: 'closed',
        at: '2026-08-14T12:00:00+09:00',
        projectId: 'proj-2',
        title: 'もうひとつ',
        priority: 3,
      }),
      makeEvent({
        id: 'bdboard-created',
        kind: 'created',
        at: '2026-08-15T07:00:00+09:00',
        title: 'should not appear',
      }),
      makeEvent({
        id: 'bdboard-started',
        kind: 'started',
        at: '2026-08-15T06:00:00+09:00',
        title: 'also excluded',
      }),
    ];

    const board = makeBoard({
      in_progress: [
        makeCard({
          lane: 'in_progress',
          projectId: 'proj-1',
          ticket: makeTicket('bdboard-c', '作業中のもの', 'proj-1', 0),
          sessions: [
            makeSession({ sessionId: 'session-active', liveness: 'active' }),
            makeSession({ sessionId: 'session-idle', liveness: 'idle' }),
          ],
        }),
      ],
      blocked: [
        makeCard({
          lane: 'blocked',
          projectId: 'proj-2',
          ticket: makeTicket('bdboard-d', '詰まってるもの', 'proj-2', 2),
          blockedBy: ['bdboard-x', 'bdboard-y'],
        }),
      ],
      ready: [
        makeCard({
          lane: 'ready',
          projectId: 'proj-1',
          ticket: makeTicket('bdboard-e', '判断が要るもの', 'proj-1', 1),
        }),
      ],
    });

    const pendingDecisions: PendingDecisionDto[] = [
      {
        id: 'bdboard-e',
        kind: 'ticket',
        projectId: 'proj-1',
        question: 'A と B どっち?',
        allowFreeform: false,
      },
    ];

    const markdown = buildDailyDigestMarkdown(
      makeInput({
        activityEvents,
        board,
        pendingDecisions,
        projectNames,
      }),
    );

    expect(markdown).toBe(
      [
        '# デイリーダイジェスト 2026-08-15 09:30 (直近24時間)',
        '',
        '## 完了 (2件)',
        '- [Project One] bdboard-a やったこと (P1)',
        '- [Project Two] bdboard-b もうひとつ (P3)',
        '',
        '## 優先度変更 (0件)',
        '- なし',
        '',
        '## 進行中 (1件)',
        '- [Project One] bdboard-c 作業中のもの (P0) — セッション 2件 (稼働中 1件)',
        '',
        '## ブロック中 (1件)',
        '- [Project Two] bdboard-d 詰まってるもの (P2) — 待ち: bdboard-x, bdboard-y',
        '',
        '## 決定待ち (1件)',
        '- [Project One] bdboard-e 判断が要るもの — A と B どっち?',
      ].join('\n'),
    );
  });

  it('excludes non-closed activity events from the completed section', () => {
    const markdown = buildDailyDigestMarkdown(
      makeInput({
        activityEvents: [
          makeEvent({
            id: 'bdboard-created',
            kind: 'created',
            at: '2026-08-15T08:00:00+09:00',
          }),
          makeEvent({
            id: 'bdboard-started',
            kind: 'started',
            at: '2026-08-15T07:00:00+09:00',
          }),
          makeEvent({
            id: 'bdboard-closed',
            kind: 'closed',
            at: '2026-08-15T06:00:00+09:00',
            title: 'only closed',
          }),
        ],
        projectNames: new Map([['proj-1', 'Project One']]),
      }),
    );

    expect(markdown).toContain('## 完了 (1件)');
    expect(markdown).toContain('- [Project One] bdboard-closed only closed (P2)');
    expect(markdown).not.toContain('bdboard-created');
    expect(markdown).not.toContain('bdboard-started');
  });

  it('sorts completed events by at descending then id ascending', () => {
    const markdown = buildDailyDigestMarkdown(
      makeInput({
        activityEvents: [
          makeEvent({
            id: 'bdboard-z',
            kind: 'closed',
            at: '2026-08-15T10:00:00+09:00',
            title: 'same time z',
          }),
          makeEvent({
            id: 'bdboard-a',
            kind: 'closed',
            at: '2026-08-15T10:00:00+09:00',
            title: 'same time a',
          }),
          makeEvent({
            id: 'bdboard-m',
            kind: 'closed',
            at: '2026-08-15T09:00:00+09:00',
            title: 'older',
          }),
        ],
        projectNames: new Map([['proj-1', 'Project One']]),
      }),
    );

    const completedSection = markdown.split('\n\n')[1];
    expect(completedSection).toBe(
      [
        '## 完了 (3件)',
        '- [Project One] bdboard-a same time a (P2)',
        '- [Project One] bdboard-z same time z (P2)',
        '- [Project One] bdboard-m older (P2)',
      ].join('\n'),
    );
  });

  it('sorts equivalent instants with different ISO representations by id ascending', () => {
    const markdown = buildDailyDigestMarkdown(
      makeInput({
        activityEvents: [
          makeEvent({
            id: 'bdboard-z',
            kind: 'closed',
            at: '2026-08-15T10:00:00+09:00',
            title: 'z ticket',
          }),
          makeEvent({
            id: 'bdboard-a',
            kind: 'closed',
            at: '2026-08-15T01:00:00.000Z',
            title: 'a ticket',
          }),
        ],
        projectNames: new Map([['proj-1', 'Project One']]),
      }),
    );

    const completedSection = markdown.split('\n\n')[1];
    expect(completedSection).toBe(
      [
        '## 完了 (2件)',
        '- [Project One] bdboard-a a ticket (P2)',
        '- [Project One] bdboard-z z ticket (P2)',
      ].join('\n'),
    );
  });

  it('omits title when normalized title is empty', () => {
    const markdown = buildDailyDigestMarkdown(
      makeInput({
        activityEvents: [
          makeEvent({
            id: 'bdboard-a',
            kind: 'closed',
            at: '2026-08-15T08:00:00+09:00',
            title: '   ',
            priority: 2,
          }),
        ],
        projectNames: new Map([['proj-1', 'Project One']]),
      }),
    );

    expect(markdown).toContain('- [Project One] bdboard-a (P2)');
    expect(markdown).not.toContain('bdboard-a  (P');
  });

  it('renders empty sections with zero counts and placeholder lines', () => {
    const markdownWithNullBoard = buildDailyDigestMarkdown(makeInput({ board: null }));
    expect(markdownWithNullBoard).toBe(
      [
        '# デイリーダイジェスト 2026-08-15 09:30 (直近24時間)',
        '',
        '## 完了 (0件)',
        '- なし',
        '',
        '## 優先度変更 (0件)',
        '- なし',
        '',
        '## 進行中 (0件)',
        '- なし',
        '',
        '## ブロック中 (0件)',
        '- なし',
        '',
        '## 決定待ち (0件)',
        '- なし',
      ].join('\n'),
    );

    const markdownWithEmptyBoard = buildDailyDigestMarkdown(
      makeInput({ board: makeBoard({}) }),
    );
    expect(markdownWithEmptyBoard).toBe(markdownWithNullBoard);
  });

  it('falls back to projectNameFallback when projectNames lacks an entry', () => {
    const projectId = '/Users/example/my-project';
    const markdown = buildDailyDigestMarkdown(
      makeInput({
        activityEvents: [
          makeEvent({
            id: 'bdboard-fallback',
            kind: 'closed',
            at: '2026-08-15T08:00:00+09:00',
            projectId,
            title: 'fallback project',
          }),
        ],
      }),
    );

    expect(markdown).toContain(
      `- [${projectNameFallback(projectId)}] bdboard-fallback fallback project (P2)`,
    );
  });

  it('filters pending decisions by selectedProjectIds only when non-empty', () => {
    const pendingDecisions: PendingDecisionDto[] = [
      {
        id: 'bdboard-one',
        kind: 'ticket',
        projectId: 'proj-1',
        question: 'Q1',
        allowFreeform: false,
      },
      {
        id: 'bdboard-two',
        kind: 'ticket',
        projectId: 'proj-2',
        question: 'Q2',
        allowFreeform: false,
      },
    ];
    const projectNames = new Map([
      ['proj-1', 'Project One'],
      ['proj-2', 'Project Two'],
    ]);

    const unfiltered = buildDailyDigestMarkdown(
      makeInput({
        pendingDecisions,
        projectNames,
        selectedProjectIds: [],
      }),
    );
    expect(unfiltered).toContain('- [Project One] bdboard-one — Q1');
    expect(unfiltered).toContain('- [Project Two] bdboard-two — Q2');

    const filtered = buildDailyDigestMarkdown(
      makeInput({
        pendingDecisions,
        projectNames,
        selectedProjectIds: ['proj-1'],
      }),
    );
    expect(filtered).toContain('## 決定待ち (1件)');
    expect(filtered).toContain('- [Project One] bdboard-one — Q1');
    expect(filtered).not.toContain('bdboard-two');
  });

  it('formats in-progress session counts and zero-session cards', () => {
    const projectNames = new Map([['proj-1', 'Project One']]);
    const board = makeBoard({
      in_progress: [
        makeCard({
          lane: 'in_progress',
          projectId: 'proj-1',
          ticket: makeTicket('bdboard-no-session', 'no sessions', 'proj-1', 1),
          sessions: [],
        }),
        makeCard({
          lane: 'in_progress',
          projectId: 'proj-1',
          ticket: makeTicket('bdboard-with-sessions', 'with sessions', 'proj-1', 2),
          sessions: [
            makeSession({ sessionId: 's1', liveness: 'active' }),
            makeSession({ sessionId: 's2', liveness: 'idle' }),
            makeSession({ sessionId: 's3', liveness: 'active' }),
          ],
        }),
      ],
    });

    const markdown = buildDailyDigestMarkdown(
      makeInput({ board, projectNames }),
    );

    expect(markdown).toContain(
      '- [Project One] bdboard-no-session no sessions (P1) — セッションなし',
    );
    expect(markdown).toContain(
      '- [Project One] bdboard-with-sessions with sessions (P2) — セッション 3件 (稼働中 2件)',
    );
  });

  it('shows placeholder text when blockedBy is empty', () => {
    const markdown = buildDailyDigestMarkdown(
      makeInput({
        board: makeBoard({
          blocked: [
            makeCard({
              lane: 'blocked',
              projectId: 'proj-1',
              ticket: makeTicket('bdboard-blocked', 'blocked item', 'proj-1', 2),
              blockedBy: [],
            }),
          ],
        }),
        projectNames: new Map([['proj-1', 'Project One']]),
      }),
    );

    expect(markdown).toContain(
      '- [Project One] bdboard-blocked blocked item (P2) — 待ち: なし',
    );
  });

  it('normalizes multiline titles and questions to a single line', () => {
    const markdown = buildDailyDigestMarkdown(
      makeInput({
        activityEvents: [
          makeEvent({
            id: 'bdboard-multiline-title',
            kind: 'closed',
            at: '2026-08-15T08:00:00+09:00',
            title: 'line one\nline   two',
          }),
        ],
        pendingDecisions: [
          {
            id: 'bdboard-multiline-question',
            kind: 'ticket',
            projectId: 'proj-1',
            question: 'ask\n  this',
            allowFreeform: false,
          },
        ],
        projectNames: new Map([['proj-1', 'Project One']]),
      }),
    );

    expect(markdown).toContain(
      '- [Project One] bdboard-multiline-title line one line two (P2)',
    );
    expect(markdown).toContain('- [Project One] bdboard-multiline-question — ask this');
  });

  it('uses placeholder text when question is undefined', () => {
    const markdown = buildDailyDigestMarkdown(
      makeInput({
        pendingDecisions: [
          {
            id: 'bdboard-no-question',
            kind: 'ticket',
            projectId: 'proj-1',
            allowFreeform: false,
          },
        ],
        projectNames: new Map([['proj-1', 'Project One']]),
      }),
    );

    expect(markdown).toContain('- [Project One] bdboard-no-question — (質問文なし)');
  });

  it('appends normalized reason to completed lines when present', () => {
    const markdown = buildDailyDigestMarkdown(
      makeInput({
        activityEvents: [
          makeEvent({
            id: 'bdboard-with-reason',
            kind: 'closed',
            at: '2026-08-15T08:00:00+09:00',
            title: 'done item',
            reason: 'example\n completion reason',
          }),
        ],
        projectNames: new Map([['proj-1', 'Project One']]),
      }),
    );

    expect(markdown).toContain(
      '- [Project One] bdboard-with-reason done item (P2) — example completion reason',
    );
  });

  it('renders priority_changed events in a dedicated section', () => {
    const markdown = buildDailyDigestMarkdown(
      makeInput({
        activityEvents: [
          makeEvent({
            id: 'bdboard-priority',
            kind: 'priority_changed',
            at: '2026-08-15T10:00:00+09:00',
            title: 'priority ticket',
            priority: 1,
            from: '2',
            to: '0',
          }),
          makeEvent({
            id: 'bdboard-closed',
            kind: 'closed',
            at: '2026-08-15T09:00:00+09:00',
            title: 'closed only',
          }),
        ],
        projectNames: new Map([['proj-1', 'Project One']]),
      }),
    );

    expect(markdown).toContain('## 優先度変更 (1件)');
    expect(markdown).toContain(
      '- [Project One] bdboard-priority priority ticket (P1) — 2 → 0',
    );
    expect(markdown).toContain('## 完了 (1件)');
    expect(markdown).toContain('- [Project One] bdboard-closed closed only (P2)');
  });
});
