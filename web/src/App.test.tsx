import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BoardViewDto,
  BoardCardDto,
  BoardDto,
  ChatAvailabilityDto,
  CommentDto,
  PendingDecisionDto,
  ProjectDto,
  ProjectBoardDto,
  SessionDto,
  StatusDto,
  SyncHealthDto,
  TicketDetailDto,
} from './api';
import { App, formatGeneratedAtAge } from './App';
import { WatchedTicketsProvider } from './components/WatchedTicketsProvider';
import { UI_STORAGE_KEYS } from './uiPersistedState';

class MockEventSource {
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener() {}
  removeEventListener() {}
  close = vi.fn();
}

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    fetchProjects: vi.fn(),
    fetchSessions: vi.fn(),
    fetchStatus: vi.fn(),
    fetchBoard: vi.fn(),
    fetchPendingDecisions: vi.fn(),
    fetchSyncHealth: vi.fn(),
    fetchChatAvailability: vi.fn(),
    fetchTicket: vi.fn(),
    fetchTicketComments: vi.fn(),
    searchTickets: vi.fn(),
    fetchTunnel: vi.fn(),
    fetchAiQuota: vi.fn(),
    fetchBoardThresholdsConfig: vi.fn(),
  };
});

import {
  fetchBoard,
  fetchBoardThresholdsConfig,
  fetchChatAvailability,
  fetchPendingDecisions,
  fetchProjects,
  fetchSessions,
  fetchStatus,
  fetchSyncHealth,
  fetchTicket,
  fetchTicketComments,
  fetchTunnel,
  fetchAiQuota,
} from './api';

const fetchProjectsMock = vi.mocked(fetchProjects);
const fetchSessionsMock = vi.mocked(fetchSessions);
const fetchStatusMock = vi.mocked(fetchStatus);
const fetchBoardMock = vi.mocked(fetchBoard);
const fetchPendingDecisionsMock = vi.mocked(fetchPendingDecisions);
const fetchSyncHealthMock = vi.mocked(fetchSyncHealth);
const fetchChatAvailabilityMock = vi.mocked(fetchChatAvailability);
const fetchTicketMock = vi.mocked(fetchTicket);
const fetchTicketCommentsMock = vi.mocked(fetchTicketComments);
const fetchTunnelMock = vi.mocked(fetchTunnel);
const fetchAiQuotaMock = vi.mocked(fetchAiQuota);
const fetchBoardThresholdsConfigMock = vi.mocked(fetchBoardThresholdsConfig);

function makeBoardThresholdsConfig() {
  return {
    stalledAfterMs: 86_400_000,
    livenessActiveMs: 120_000,
    livenessIdleMs: 1_800_000,
    livenessStaleMs: 86_400_000,
    inProgressWipLimit: null,
    inProgressWipLimitByProject: {},
    version: 'thresholds-v1',
    defaults: {
      stalledAfterMs: 86_400_000,
      livenessActiveMs: 120_000,
      livenessIdleMs: 1_800_000,
      livenessStaleMs: 86_400_000,
      inProgressWipLimit: null,
      inProgressWipLimitByProject: {},
    },
  };
}

beforeEach(() => {
  fetchBoardThresholdsConfigMock.mockResolvedValue(makeBoardThresholdsConfig());
});

const ticketId = 'bdboard-3tw.94';

const sampleTicket: TicketDetailDto = {
  id: ticketId,
  projectId: 'proj-1',
  title: 'Deep link ticket',
  status: 'open',
  priority: 2,
  issueType: 'task',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  dependencies: [],
  blockedBy: [],
  blocks: [],
  commentCount: 0,
  sessionLinks: [],
  models: [],
  children: [],
};

const emptyBoard: BoardViewDto = {
  mode: 'merged',
  generatedAt: '2026-01-01T00:00:00.000Z',
  projects: [],
  merged: {
    lanes: { ready: [], in_progress: [], blocked: [], done: [] },
    cardCount: 0,
    closedTotal: 0,
    truncatedClosedIds: [],
  },
};

const filterSampleProject: ProjectDto = {
  id: 'proj-1',
  name: 'Project One',
  rootPath: '/projects/a',
  prefixes: ['bdboard'],
  sessionCount: 0,
  activeSessionCount: 0,
  sessions: [],
};

function makeFilterCard(
  id: string,
  lane: BoardCardDto['lane'],
  options: {
    priority?: number;
    issueType?: string;
    title?: string;
    stalled?: boolean;
    status?: string;
    projectId?: string;
  } = {},
): BoardCardDto {
  const status =
    options.status ?? (lane === 'done' ? 'closed' : lane === 'in_progress' ? 'in_progress' : 'open');
  const priority = options.priority ?? 2;
  return {
    ticket: {
      id,
      projectId: options.projectId ?? 'proj-1',
      title: options.title ?? id,
      status,
      priority,
      issueType: options.issueType ?? 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
    },
    lane,
    projectId: options.projectId ?? 'proj-1',
    blockedBy: [],
    blocks: [],
    unblocksCount: 0,
    liveness: null,
    sessions: [],
    stalled: options.stalled ?? false,
    epicProgress: null,
    deferDays: null,
    deferUrgency: null,
    effectivePriority: priority,
    priorityInheritedFrom: null,
  };
}

function makeEmptyLanes(): BoardDto['lanes'] {
  return {
    ready: [],
    in_progress: [],
    awaiting_human: [],
    blocked: [],
    done: [],
  };
}

function priorityFilterBoardView(): BoardViewDto {
  const mergedBoard: BoardDto = {
    lanes: {
      ...makeEmptyLanes(),
      ready: [
        makeFilterCard('filter-p0-ready', 'ready', { priority: 0, title: 'Priority P0 Ready' }),
        makeFilterCard('filter-p3-ready', 'ready', { priority: 3, title: 'Priority P3 Ready' }),
      ],
      in_progress: [
        makeFilterCard('filter-p1-progress', 'in_progress', {
          priority: 1,
          title: 'Priority P1 Progress',
          status: 'in_progress',
        }),
      ],
    },
    cardCount: 3,
    closedTotal: 0,
    truncatedClosedIds: [],
  };

  const splitBoard: BoardDto = {
    lanes: {
      ...makeEmptyLanes(),
      ready: [
        makeFilterCard('split-p0-ready', 'ready', { priority: 0, title: 'Split P0 Ready' }),
        makeFilterCard('split-p3-ready', 'ready', { priority: 3, title: 'Split P3 Ready' }),
      ],
    },
    cardCount: 2,
    closedTotal: 0,
    truncatedClosedIds: [],
  };

  return {
    mode: 'merged',
    generatedAt: '2026-01-01T00:00:00.000Z',
    projects: [
      {
        project: filterSampleProject,
        board: splitBoard,
      } satisfies ProjectBoardDto,
    ],
    merged: mergedBoard,
  };
}

function compositeFilterBoardView(): BoardViewDto {
  const mergedBoard: BoardDto = {
    lanes: {
      ...makeEmptyLanes(),
      ready: [
        makeFilterCard('combo-ready-p0', 'ready', {
          priority: 0,
          title: 'Combo Ready P0',
        }),
        makeFilterCard('combo-ready-p3', 'ready', {
          priority: 3,
          title: 'Combo Ready P3',
        }),
        makeFilterCard('combo-stalled-bug', 'ready', {
          priority: 1,
          issueType: 'bug',
          stalled: true,
          title: 'Combo Stalled Bug',
        }),
        makeFilterCard('combo-stalled-task', 'ready', {
          priority: 1,
          issueType: 'task',
          stalled: true,
          title: 'Combo Stalled Task',
        }),
        makeFilterCard('combo-fresh-bug', 'ready', {
          priority: 1,
          issueType: 'bug',
          stalled: false,
          title: 'Combo Fresh Bug',
        }),
      ],
      done: [
        makeFilterCard('combo-done-p0', 'done', {
          priority: 0,
          title: 'Combo Done P0',
          status: 'closed',
        }),
      ],
    },
    cardCount: 6,
    closedTotal: 1,
    truncatedClosedIds: [],
  };

  return {
    mode: 'merged',
    generatedAt: '2026-01-01T00:00:00.000Z',
    projects: [
      {
        project: filterSampleProject,
        board: mergedBoard,
      } satisfies ProjectBoardDto,
    ],
    merged: mergedBoard,
  };
}

function persistenceFilterBoardView(): BoardViewDto {
  const mergedBoard: BoardDto = {
    lanes: {
      ...makeEmptyLanes(),
      ready: [
        makeFilterCard('persist-match', 'ready', {
          priority: 1,
          issueType: 'bug',
          title: 'Persist Match UniqueText',
        }),
        makeFilterCard('persist-miss-priority', 'ready', {
          priority: 3,
          issueType: 'bug',
          title: 'Persist Miss Priority UniqueText',
        }),
        makeFilterCard('persist-miss-type', 'ready', {
          priority: 2,
          issueType: 'task',
          title: 'Persist Miss Type UniqueText',
        }),
      ],
    },
    cardCount: 3,
    closedTotal: 0,
    truncatedClosedIds: [],
  };

  return {
    mode: 'merged',
    generatedAt: '2026-01-01T00:00:00.000Z',
    projects: [
      {
        project: filterSampleProject,
        board: mergedBoard,
      } satisfies ProjectBoardDto,
    ],
    merged: mergedBoard,
  };
}

function setupFilterApiMocks(boardView: BoardViewDto) {
  fetchProjectsMock.mockResolvedValue([filterSampleProject]);
  fetchBoardMock.mockResolvedValue(boardView);
}

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <WatchedTicketsProvider>
        <App />
      </WatchedTicketsProvider>
    </QueryClientProvider>,
  );
}

describe('App ticket deep link', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource);
    window.history.replaceState(null, '', '/');
    localStorage.clear();

    fetchProjectsMock.mockResolvedValue([
      {
        id: 'proj-1',
        name: 'Project One',
        rootPath: '/projects/a',
        prefixes: ['bdboard'],
        sessionCount: 0,
        activeSessionCount: 0,
        sessions: [],
      } satisfies ProjectDto,
    ]);
    fetchSessionsMock.mockResolvedValue([] satisfies SessionDto[]);
    fetchStatusMock.mockResolvedValue({
      lastRefreshAt: '2026-01-01T00:00:00.000Z',
      errors: [],
      projectCount: 1,
    } satisfies StatusDto);
    fetchBoardMock.mockResolvedValue(emptyBoard);
    fetchPendingDecisionsMock.mockResolvedValue([] satisfies PendingDecisionDto[]);
    fetchSyncHealthMock.mockResolvedValue([] satisfies SyncHealthDto[]);
    fetchChatAvailabilityMock.mockResolvedValue({
      availability: 'unavailable',
    } satisfies ChatAvailabilityDto);
    fetchTicketMock.mockResolvedValue(sampleTicket);
    fetchTicketCommentsMock.mockResolvedValue([] satisfies CommentDto[]);
    fetchTunnelMock.mockResolvedValue({
      state: 'off',
      available: true,
      authEnabled: true,
    });
    fetchAiQuotaMock.mockRejectedValue(new Error('not configured'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('opens TicketDetailPanel from #ticket= hash (AC1)', async () => {
    window.history.replaceState(null, '', `/#ticket=${ticketId}`);

    renderApp();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Deep link ticket' })).toBeInTheDocument();
    });
  });

  it('clears hash when detail close button is clicked (AC2)', async () => {
    window.history.replaceState(null, '', `/#ticket=${ticketId}`);

    renderApp();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: '閉じる' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
  });
});

describe('board filter acceptance criteria (bdboard-3tw.101)', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource);
    window.history.replaceState(null, '', '/');
    localStorage.clear();

    fetchSessionsMock.mockResolvedValue([] satisfies SessionDto[]);
    fetchStatusMock.mockResolvedValue({
      lastRefreshAt: '2026-01-01T00:00:00.000Z',
      errors: [],
      projectCount: 1,
    } satisfies StatusDto);
    fetchPendingDecisionsMock.mockResolvedValue([] satisfies PendingDecisionDto[]);
    fetchSyncHealthMock.mockResolvedValue([] satisfies SyncHealthDto[]);
    fetchChatAvailabilityMock.mockResolvedValue({
      availability: 'unavailable',
    } satisfies ChatAvailabilityDto);
    fetchTicketMock.mockResolvedValue(sampleTicket);
    fetchTicketCommentsMock.mockResolvedValue([] satisfies CommentDto[]);
    fetchTunnelMock.mockResolvedValue({
      state: 'off',
      available: true,
      authEnabled: true,
    });
    fetchAiQuotaMock.mockRejectedValue(new Error('not configured'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('AC1: priority ceiling hides cards from merged view across lanes', async () => {
    const user = userEvent.setup();
    setupFilterApiMocks(priorityFilterBoardView());

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Priority P0 Ready')).toBeInTheDocument();
      expect(screen.getByText('Priority P3 Ready')).toBeInTheDocument();
      expect(screen.getByText('Priority P1 Progress')).toBeInTheDocument();
    });

    await user.selectOptions(screen.getByLabelText('優先度上限'), '1');

    expect(screen.getByText('Priority P0 Ready')).toBeInTheDocument();
    expect(screen.getByText('Priority P1 Progress')).toBeInTheDocument();
    expect(screen.queryByText('Priority P3 Ready')).not.toBeInTheDocument();
    expect(screen.queryByText('filter-p3-ready')).not.toBeInTheDocument();
  });

  it('AC1: priority ceiling hides cards from split view', async () => {
    const user = userEvent.setup();
    setupFilterApiMocks(priorityFilterBoardView());

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Priority P0 Ready')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '分割' }));

    await waitFor(() => {
      expect(screen.getByText('Split P0 Ready')).toBeInTheDocument();
      expect(screen.getByText('Split P3 Ready')).toBeInTheDocument();
    });

    await user.selectOptions(screen.getByLabelText('優先度上限'), '1');

    expect(screen.getByText('Split P0 Ready')).toBeInTheDocument();
    expect(screen.queryByText('Split P3 Ready')).not.toBeInTheDocument();
    expect(screen.queryByText('split-p3-ready')).not.toBeInTheDocument();
  });

  it('AC2: restores filter state from localStorage and filters cards', async () => {
    localStorage.setItem(UI_STORAGE_KEYS.boardPriorityCeiling, JSON.stringify('2'));
    localStorage.setItem(UI_STORAGE_KEYS.boardIssueTypes, JSON.stringify(['bug']));
    localStorage.setItem(UI_STORAGE_KEYS.boardFilterText, JSON.stringify('UniqueText'));

    setupFilterApiMocks(persistenceFilterBoardView());

    renderApp();

    await waitFor(() => {
      expect(screen.getByLabelText('優先度上限')).toHaveValue('2');
      expect(screen.getByRole('button', { name: 'bug' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByLabelText('チケットの絞り込み')).toHaveValue('UniqueText');
      expect(screen.getByText('Persist Match UniqueText')).toBeInTheDocument();
    });

    expect(screen.queryByText('persist-miss-priority')).not.toBeInTheDocument();
    expect(screen.queryByText('persist-miss-type')).not.toBeInTheDocument();
  });

  it('AC3: hideDone and priority ceiling combine without canceling each other', async () => {
    const user = userEvent.setup();
    setupFilterApiMocks(compositeFilterBoardView());

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Combo Ready P0')).toBeInTheDocument();
      expect(screen.getByText('Combo Ready P3')).toBeInTheDocument();
    });

    await user.selectOptions(screen.getByLabelText('優先度上限'), '1');

    expect(screen.getByText('Combo Ready P0')).toBeInTheDocument();
    expect(screen.queryByText('Combo Ready P3')).not.toBeInTheDocument();
    expect(screen.queryByText('combo-done-p0')).not.toBeInTheDocument();
  });

  it('AC3: stalledOnly and issue type chips combine without canceling each other', async () => {
    const user = userEvent.setup();
    setupFilterApiMocks(compositeFilterBoardView());

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Combo Stalled Bug')).toBeInTheDocument();
      expect(screen.getByText('Combo Stalled Task')).toBeInTheDocument();
      expect(screen.getByText('Combo Fresh Bug')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('滞留のみ表示'));
    await user.click(screen.getByRole('button', { name: 'bug' }));

    expect(screen.getByText('Combo Stalled Bug')).toBeInTheDocument();
    expect(screen.queryByText('Combo Stalled Task')).not.toBeInTheDocument();
    expect(screen.queryByText('Combo Fresh Bug')).not.toBeInTheDocument();
  });
});

describe('board filter presets (bdboard-3tw.112)', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource);
    window.history.replaceState(null, '', '/');
    localStorage.clear();

    fetchSessionsMock.mockResolvedValue([] satisfies SessionDto[]);
    fetchStatusMock.mockResolvedValue({
      lastRefreshAt: '2026-01-01T00:00:00.000Z',
      errors: [],
      projectCount: 1,
    } satisfies StatusDto);
    fetchPendingDecisionsMock.mockResolvedValue([] satisfies PendingDecisionDto[]);
    fetchSyncHealthMock.mockResolvedValue([] satisfies SyncHealthDto[]);
    fetchChatAvailabilityMock.mockResolvedValue({
      availability: 'unavailable',
    } satisfies ChatAvailabilityDto);
    fetchTicketMock.mockResolvedValue(sampleTicket);
    fetchTicketCommentsMock.mockResolvedValue([] satisfies CommentDto[]);
    fetchTunnelMock.mockResolvedValue({
      state: 'off',
      available: true,
      authEnabled: true,
    });
    fetchAiQuotaMock.mockRejectedValue(new Error('not configured'));
    setupFilterApiMocks(persistenceFilterBoardView());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('applies a saved preset from the header in one tap', async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      UI_STORAGE_KEYS.boardFilterPresets,
      JSON.stringify([
        {
          id: 'preset-bug-filter',
          name: 'P1バグだけ',
          view: 'merged',
          selectedProjectIds: ['proj-1'],
          priorityCeiling: '1',
          issueTypes: ['bug'],
          labels: [],
          filterText: 'UniqueText',
        },
      ]),
    );
    localStorage.setItem(UI_STORAGE_KEYS.boardPriorityCeiling, JSON.stringify('all'));
    localStorage.setItem(UI_STORAGE_KEYS.boardIssueTypes, JSON.stringify([]));
    localStorage.setItem(UI_STORAGE_KEYS.boardFilterText, JSON.stringify(''));

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Persist Match UniqueText')).toBeInTheDocument();
      expect(screen.getByText('Persist Miss Priority UniqueText')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'P1バグだけ' }));

    await waitFor(() => {
      expect(screen.getByLabelText('優先度上限')).toHaveValue('1');
      expect(screen.getByRole('button', { name: 'bug' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByLabelText('チケットの絞り込み')).toHaveValue('UniqueText');
      expect(screen.getByText('Persist Match UniqueText')).toBeInTheDocument();
    });

    expect(screen.queryByText('Persist Miss Priority UniqueText')).not.toBeInTheDocument();
    expect(screen.queryByText('Persist Miss Type UniqueText')).not.toBeInTheDocument();
  });
});

describe('header help overlays', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource);
    window.history.replaceState(null, '', '/');
    localStorage.clear();

    fetchSessionsMock.mockResolvedValue([] satisfies SessionDto[]);
    fetchStatusMock.mockResolvedValue({
      lastRefreshAt: '2026-01-01T00:00:00.000Z',
      errors: [],
      projectCount: 1,
    } satisfies StatusDto);
    fetchPendingDecisionsMock.mockResolvedValue([] satisfies PendingDecisionDto[]);
    fetchSyncHealthMock.mockResolvedValue([] satisfies SyncHealthDto[]);
    fetchChatAvailabilityMock.mockResolvedValue({
      availability: 'unavailable',
    } satisfies ChatAvailabilityDto);
    fetchTicketMock.mockResolvedValue(sampleTicket);
    fetchTicketCommentsMock.mockResolvedValue([] satisfies CommentDto[]);
    fetchTunnelMock.mockResolvedValue({
      state: 'off',
      available: true,
      authEnabled: true,
    });
    fetchAiQuotaMock.mockRejectedValue(new Error('not configured'));
    setupFilterApiMocks(priorityFilterBoardView());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('opens the shortcuts overlay on ? and closes on second ?', async () => {
    const user = userEvent.setup();
    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Priority P0 Ready')).toBeInTheDocument();
    });

    await user.keyboard('?');

    expect(
      screen.getByRole('dialog', { name: 'キーボードショートカット' }),
    ).toBeInTheDocument();
    expect(screen.getByText('⌘/Ctrl + K')).toBeInTheDocument();

    await user.keyboard('?');

    expect(
      screen.queryByRole('dialog', { name: 'キーボードショートカット' }),
    ).not.toBeInTheDocument();
  });

  it('does not open shortcuts on ? while an input is focused', async () => {
    const user = userEvent.setup();
    renderApp();

    await waitFor(() => {
      expect(screen.getByLabelText('優先度上限')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('優先度上限'));
    await user.keyboard('?');

    expect(
      screen.queryByRole('dialog', { name: 'キーボードショートカット' }),
    ).not.toBeInTheDocument();
  });

  it('opens shortcuts from the header button', async () => {
    const user = userEvent.setup();
    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Priority P0 Ready')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'キーボードショートカット (?)' }));

    expect(
      screen.getByRole('dialog', { name: 'キーボードショートカット' }),
    ).toBeInTheDocument();
  });

  it('opens the feature help panel from the header button', async () => {
    const user = userEvent.setup();
    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Priority P0 Ready')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'ヘルプ' }));

    expect(screen.getByRole('dialog', { name: 'ヘルプ' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Kanban（看板）' })).toBeInTheDocument();
  });
});

describe('formatGeneratedAtAge (bdboard-3tw.125)', () => {
  const nowMs = new Date('2026-01-01T12:00:00.000Z').getTime();

  it('returns たった今 for less than 1 minute', () => {
    expect(formatGeneratedAtAge('2026-01-01T11:59:30.000Z', nowMs)).toBe('たった今');
  });

  it('returns N分前 for 1–59 minutes', () => {
    expect(formatGeneratedAtAge('2026-01-01T11:55:00.000Z', nowMs)).toBe('5分前');
  });

  it('returns N時間前 for 60+ minutes', () => {
    expect(formatGeneratedAtAge('2026-01-01T10:00:00.000Z', nowMs)).toBe('2時間前');
  });
});

describe('board generatedAt freshness (bdboard-3tw.125)', () => {
  const fixedNowMs = new Date('2026-01-01T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource);
    window.history.replaceState(null, '', '/');
    localStorage.clear();

    fetchProjectsMock.mockResolvedValue([
      {
        id: 'proj-1',
        name: 'Project One',
        rootPath: '/projects/a',
        prefixes: ['bdboard'],
        sessionCount: 0,
        activeSessionCount: 0,
        sessions: [],
      } satisfies ProjectDto,
    ]);
    fetchSessionsMock.mockResolvedValue([] satisfies SessionDto[]);
    fetchStatusMock.mockResolvedValue({
      lastRefreshAt: '2026-01-01T00:00:00.000Z',
      errors: [],
      projectCount: 1,
    } satisfies StatusDto);
    fetchBoardMock.mockResolvedValue({
      ...emptyBoard,
      generatedAt: '2026-01-01T11:55:00.000Z',
    });
    fetchPendingDecisionsMock.mockResolvedValue([] satisfies PendingDecisionDto[]);
    fetchSyncHealthMock.mockResolvedValue([] satisfies SyncHealthDto[]);
    fetchChatAvailabilityMock.mockResolvedValue({
      availability: 'unavailable',
    } satisfies ChatAvailabilityDto);
    fetchTicketMock.mockResolvedValue(sampleTicket);
    fetchTicketCommentsMock.mockResolvedValue([] satisfies CommentDto[]);
    fetchTunnelMock.mockResolvedValue({
      state: 'off',
      available: true,
      authEnabled: true,
    });
    fetchAiQuotaMock.mockRejectedValue(new Error('not configured'));

    vi.spyOn(Date, 'now').mockReturnValue(fixedNowMs);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders board generatedAt freshness near stream indicator', async () => {
    renderApp();

    await waitFor(() => {
      expect(screen.getByText('盤面取得: 5分前')).toBeInTheDocument();
    });
    expect(screen.getByText(/最終更新:/)).toBeInTheDocument();
  });
});
