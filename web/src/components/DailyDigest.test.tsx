import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActivityEventDto,
  BoardCardDto,
  BoardDto,
  BoardViewDto,
  PendingDecisionDto,
  ProjectDto,
  SessionDto,
} from '../api';
import { buildDailyDigestMarkdown } from './dailyDigestMarkdown';
import { DailyDigest } from './DailyDigest';

vi.mock('../api', () => ({
  fetchActivity: vi.fn(),
  fetchBoard: vi.fn(),
  fetchPendingDecisions: vi.fn(),
  fetchProjects: vi.fn(),
  LANES: ['ready', 'in_progress', 'awaiting_human', 'blocked', 'done'],
  projectNameFallback: (id: string) => id.split(/[/\\]/).pop() ?? id,
}));

vi.mock('../bdCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bdCommands')>();
  return { ...actual, copyTextToClipboard: vi.fn() };
});

import {
  fetchActivity,
  fetchBoard,
  fetchPendingDecisions,
  fetchProjects,
} from '../api';
import { copyTextToClipboard } from '../bdCommands';

const fetchActivityMock = vi.mocked(fetchActivity);
const fetchBoardMock = vi.mocked(fetchBoard);
const fetchPendingDecisionsMock = vi.mocked(fetchPendingDecisions);
const fetchProjectsMock = vi.mocked(fetchProjects);
const copyTextToClipboardMock = vi.mocked(copyTextToClipboard);

const FIXED_NOW = new Date('2026-08-15T09:30:00+09:00');

function makeEvent(
  overrides: Partial<ActivityEventDto> & Pick<ActivityEventDto, 'id' | 'kind' | 'at'>,
): ActivityEventDto {
  return {
    projectId: 'proj-a',
    projectName: 'Project Alpha',
    title: 'Completed ticket',
    status: 'closed',
    priority: 1,
    issueType: 'task',
    ...overrides,
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

const defaultProjects: ProjectDto[] = [
  {
    id: 'proj-a',
    name: 'Project Alpha',
    rootPath: '/tmp/proj-a',
    prefixes: [],
    sessionCount: 0,
    activeSessionCount: 0,
    incompleteTicketCount: 0,
    sessions: [],
  },
];

const defaultActivityEvents: ActivityEventDto[] = [
  makeEvent({
    id: 'bdboard-done',
    kind: 'closed',
    at: '2026-08-15T08:00:00+09:00',
    title: 'Shipped feature',
  }),
];

function makeTicket(id: string, title: string, priority: number) {
  return {
    id,
    projectId: 'proj-a',
    title,
    status: 'open',
    priority,
    issueType: 'task',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    commentCount: 0,
  };
}

function makeSession(sessionId: string, liveness: SessionDto['liveness']): SessionDto {
  return {
    sessionId,
    pid: 1,
    cwd: '/tmp/work',
    alive: true,
    startedAt: '2026-08-15T00:00:00.000Z',
    lastActivityAt: '2026-08-15T01:00:00.000Z',
    liveness,
  };
}

function makeCard(
  overrides: Partial<BoardCardDto> & Pick<BoardCardDto, 'ticket' | 'lane'>,
): BoardCardDto {
  return {
    projectId: 'proj-a',
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

// 進行中/ブロック中のカードを必ず含めておく。空ボードだと board を渡し損ねても
// （merged ではなく null を渡しても）Markdown が同一になり、配線ミスをテストが
// 素通ししてしまうため。
const defaultBoardResponse: BoardViewDto = {
  mode: 'merged',
  generatedAt: '2026-08-15T00:00:00.000Z',
  merged: makeBoard({
    in_progress: [
      makeCard({
        lane: 'in_progress',
        ticket: makeTicket('bdboard-wip', 'Work in progress', 0),
        sessions: [makeSession('s-active', 'active'), makeSession('s-idle', 'idle')],
      }),
    ],
    blocked: [
      makeCard({
        lane: 'blocked',
        ticket: makeTicket('bdboard-blocked', 'Blocked ticket', 2),
        blockedBy: ['bdboard-x'],
      }),
    ],
  }),
  projects: [],
};

const defaultPendingDecisions: PendingDecisionDto[] = [
  {
    id: 'bdboard-pending',
    projectId: 'proj-a',
    question: 'Which option?',
    allowFreeform: false,
  },
];

function expectedMarkdown(): string {
  return buildDailyDigestMarkdown({
    now: FIXED_NOW,
    windowDays: 1,
    activityEvents: defaultActivityEvents,
    board: defaultBoardResponse.merged,
    pendingDecisions: defaultPendingDecisions,
    projectNames: new Map(defaultProjects.map((project) => [project.id, project.name])),
    selectedProjectIds: ['proj-a'],
  });
}

function mockAllQueries(options?: {
  activityEvents?: ActivityEventDto[];
  boardResponse?: BoardViewDto;
  pendingDecisions?: PendingDecisionDto[];
  projects?: ProjectDto[];
  activityReject?: Error;
  boardReject?: Error;
  pendingReject?: Error;
  projectsReject?: Error;
}) {
  if (options?.activityReject !== undefined) {
    fetchActivityMock.mockRejectedValue(options.activityReject);
  } else {
    fetchActivityMock.mockResolvedValue(options?.activityEvents ?? defaultActivityEvents);
  }

  if (options?.boardReject !== undefined) {
    fetchBoardMock.mockRejectedValue(options.boardReject);
  } else {
    fetchBoardMock.mockResolvedValue(options?.boardResponse ?? defaultBoardResponse);
  }

  if (options?.pendingReject !== undefined) {
    fetchPendingDecisionsMock.mockRejectedValue(options.pendingReject);
  } else {
    fetchPendingDecisionsMock.mockResolvedValue(
      options?.pendingDecisions ?? defaultPendingDecisions,
    );
  }

  if (options?.projectsReject !== undefined) {
    fetchProjectsMock.mockRejectedValue(options.projectsReject);
  } else {
    fetchProjectsMock.mockResolvedValue(options?.projects ?? defaultProjects);
  }
}

function renderDailyDigest(
  options?: {
    projectIds?: readonly string[];
    windowDays?: 1 | 3 | 7;
    onWindowDaysChange?: (days: 1 | 3 | 7) => void;
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const onWindowDaysChange = options?.onWindowDaysChange ?? vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <DailyDigest
        projectIds={options?.projectIds ?? ['proj-a']}
        windowDays={options?.windowDays ?? 1}
        onWindowDaysChange={onWindowDaysChange}
        now={FIXED_NOW}
      />
    </QueryClientProvider>,
  );

  return { onWindowDaysChange };
}

describe('DailyDigest', () => {
  beforeEach(() => {
    fetchActivityMock.mockReset();
    fetchBoardMock.mockReset();
    fetchPendingDecisionsMock.mockReset();
    fetchProjectsMock.mockReset();
    copyTextToClipboardMock.mockReset();
    copyTextToClipboardMock.mockResolvedValue(undefined);
  });

  it('renders markdown preview after all queries resolve', async () => {
    mockAllQueries();

    renderDailyDigest();

    const heading = await screen.findByText(
      /# デイリーダイジェスト 2026-08-15 09:30 \(直近24時間\)/,
    );
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(/## 完了 \(1件\)/)).toBeInTheDocument();
    expect(screen.getByText(/## 決定待ち \(1件\)/)).toBeInTheDocument();

    // ボードのカードが実際にダイジェストへ反映されていること（board の配線の検証）。
    const previewText = heading.closest('pre')?.textContent ?? '';
    expect(previewText).toContain(
      '- [Project Alpha] bdboard-wip Work in progress (P0) — セッション 2件 (稼働中 1件)',
    );
    expect(previewText).toContain(
      '- [Project Alpha] bdboard-blocked Blocked ticket (P2) — 待ち: bdboard-x',
    );
  });

  it('copies the exact preview markdown to the clipboard', async () => {
    const user = userEvent.setup();
    mockAllQueries();

    renderDailyDigest();

    const preview = await screen.findByText(/## 決定待ち \(1件\)/);
    expect(preview.closest('pre')?.textContent).toBe(expectedMarkdown());

    await user.click(screen.getByRole('button', { name: 'Markdown をコピー' }));

    await waitFor(() => {
      expect(copyTextToClipboardMock).toHaveBeenCalledTimes(1);
    });
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(expectedMarkdown());
  });

  it('shows success feedback after copying markdown', async () => {
    const user = userEvent.setup();
    mockAllQueries();

    renderDailyDigest();

    await screen.findByText(/## 完了 \(1件\)/);
    await user.click(screen.getByRole('button', { name: 'Markdown をコピー' }));

    expect(await screen.findByText('Markdown をコピーしました')).toBeInTheDocument();
  });

  it('shows error feedback when copy fails', async () => {
    const user = userEvent.setup();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    copyTextToClipboardMock.mockRejectedValue(new Error('clipboard unavailable'));
    mockAllQueries();

    renderDailyDigest();

    await screen.findByText(/## 完了 \(1件\)/);
    await user.click(screen.getByRole('button', { name: 'Markdown をコピー' }));

    expect(await screen.findByText('コピーできませんでした')).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });

  it('calls onWindowDaysChange when a window toggle is clicked', async () => {
    const user = userEvent.setup();
    mockAllQueries();

    const { onWindowDaysChange } = renderDailyDigest();

    await screen.findByText(/## 完了 \(1件\)/);
    await user.click(screen.getByRole('button', { name: '3日' }));

    expect(onWindowDaysChange).toHaveBeenCalledWith(3);
  });

  it('passes projectIds to fetchActivity and fetchBoard', async () => {
    mockAllQueries();

    renderDailyDigest({ projectIds: ['proj-a'] });

    await screen.findByText(/## 完了 \(1件\)/);

    expect(fetchActivityMock).toHaveBeenCalledWith(1, 500, ['proj-a']);
    expect(fetchBoardMock).toHaveBeenCalledWith({
      projectIds: ['proj-a'],
      view: 'merged',
    });
  });

  it('shows an error message and hides preview when a query fails', async () => {
    mockAllQueries({
      activityReject: new Error('activity failed'),
    });

    renderDailyDigest();

    expect(await screen.findByText('activity failed')).toHaveClass('error-message');
    expect(screen.queryByText(/## 完了/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Markdown をコピー' })).toBeDisabled();
  });
});
