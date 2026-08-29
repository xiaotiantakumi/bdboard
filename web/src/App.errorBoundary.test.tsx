import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BoardViewDto,
  ChatAvailabilityDto,
  CommentDto,
  PendingDecisionDto,
  ProjectDto,
  SessionDto,
  StatusDto,
  TicketDetailDto,
} from './api';
import { App } from './App';
import { WatchedTicketsProvider } from './components/WatchedTicketsProvider';

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
    fetchChatAvailability: vi.fn(),
    fetchTicket: vi.fn(),
    fetchTicketComments: vi.fn(),
    fetchTunnel: vi.fn(),
    fetchAiQuota: vi.fn(),
    fetchBoardThresholdsConfig: vi.fn(),
  };
});

// 描画中に throw するコンポーネントの代表として詳細パネルを差し替える。
// bdboard-yfq のきっかけ (bdboard-ol9 の日付整形が不正入力で RangeError を
// 投げうる) が、まさにこのパネル内の描画だったため。
vi.mock('./components/TicketDetailPanel', () => ({
  TicketDetailPanel: () => {
    throw new Error('detail panel exploded');
  },
}));

import {
  fetchAiQuota,
  fetchBoard,
  fetchBoardThresholdsConfig,
  fetchChatAvailability,
  fetchPendingDecisions,
  fetchProjects,
  fetchSessions,
  fetchStatus,
  fetchTicket,
  fetchTicketComments,
  fetchTunnel,
} from './api';

const boardWithCard: BoardViewDto = {
  mode: 'merged',
  generatedAt: '2026-01-01T00:00:00.000Z',
  projects: [],
  merged: {
    lanes: {
      ready: [
        {
          ticket: {
            id: 'bdboard-boom',
            projectId: 'proj-1',
            title: 'Board card stays alive',
            status: 'open',
            priority: 2,
            issueType: 'task',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
            commentCount: 0,
          },
          lane: 'ready',
          projectId: 'proj-1',
          blockedBy: [],
          blocks: [],
          unblocksCount: 0,
          liveness: null,
          sessions: [],
          stalled: false,
          epicProgress: null,
          deferDays: null,
          deferUrgency: null,
          effectivePriority: 2,
          priorityInheritedFrom: null,
        },
      ],
      in_progress: [],
      blocked: [],
      done: [],
    },
    cardCount: 1,
    closedTotal: 0,
    truncatedClosedIds: [],
  },
};

const sampleTicket: TicketDetailDto = {
  id: 'bdboard-boom',
  projectId: 'proj-1',
  title: 'Board card stays alive',
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

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WatchedTicketsProvider>
        <App />
      </WatchedTicketsProvider>
    </QueryClientProvider>,
  );
}

describe('App error boundaries (bdboard-yfq)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('EventSource', MockEventSource);
    window.history.replaceState(null, '', '/');
    localStorage.clear();

    vi.mocked(fetchProjects).mockResolvedValue([
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
    vi.mocked(fetchSessions).mockResolvedValue([] satisfies SessionDto[]);
    vi.mocked(fetchStatus).mockResolvedValue({
      lastRefreshAt: '2026-01-01T00:00:00.000Z',
      errors: [],
      projectCount: 1,
    } satisfies StatusDto);
    vi.mocked(fetchBoard).mockResolvedValue(boardWithCard);
    vi.mocked(fetchPendingDecisions).mockResolvedValue([] satisfies PendingDecisionDto[]);
    vi.mocked(fetchChatAvailability).mockResolvedValue({
      availability: 'unavailable',
    } satisfies ChatAvailabilityDto);
    vi.mocked(fetchTicket).mockResolvedValue(sampleTicket);
    vi.mocked(fetchTicketComments).mockResolvedValue([] satisfies CommentDto[]);
    vi.mocked(fetchTunnel).mockResolvedValue({
      state: 'off',
      available: true,
      authEnabled: true,
    });
    vi.mocked(fetchAiQuota).mockRejectedValue(new Error('not configured'));
    vi.mocked(fetchBoardThresholdsConfig).mockResolvedValue({
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
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the board usable when the ticket detail panel throws', async () => {
    const user = userEvent.setup();
    renderApp();

    const card = await screen.findByTitle('Board card stays alive');
    await user.click(card);

    // 詳細パネルだけが fallback に置き換わる。
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'チケット詳細の表示に失敗しました',
    );
    // 境界が無い/掛け違えていると、ここで App ごとアンマウントされて
    // ボードもヘッダーも消える (= 画面が真っ白)。
    expect(screen.getByTitle('Board card stays alive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '設定' })).toBeInTheDocument();
  });

  it('closes the crashed panel from the fallback', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByTitle('Board card stays alive'));
    await screen.findByRole('alert');

    // 壊れたパネルの中にある閉じるボタンは押せないので、fallback 側が
    // 閉じる導線を持っている必要がある。
    await user.click(screen.getByRole('button', { name: '閉じる' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTitle('Board card stays alive')).toBeInTheDocument();
  });
});
