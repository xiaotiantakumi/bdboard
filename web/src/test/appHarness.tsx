import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type {
  BoardViewDto,
  ChatAvailabilityDto,
  CommentDto,
  PendingDecisionDto,
  ProjectDto,
  SessionDto,
  StatusDto,
  TicketDetailDto,
} from '../api';
import * as api from '../api';
import { App } from '../App';
import { WatchedTicketsProvider } from '../components/WatchedTicketsProvider';

/**
 * ErrorBoundary 系の App 統合テスト用ハーネス。
 *
 * 「どこが throw したときに何が生き残るか」はファイルごとに別の
 * `vi.mock` を張らないと確かめられない (throw するモックはファイル単位で効く)
 * ので、テストファイル自体は分かれる。フィクスチャと API モックの下拵えだけを
 * ここに集約して、複製が増えないようにする。
 */

export class MockEventSource {
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

export const boardWithCard: BoardViewDto = {
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

export const sampleTicket: TicketDetailDto = {
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

/**
 * 画面が立ち上がるだけの最低限の API 応答を仕込む。
 * 呼び出し側のファイルで `vi.mock('./api', ...)` 済みであることが前提。
 */
export function primeAppApiMocks(): void {
  vi.stubGlobal('EventSource', MockEventSource);
  window.history.replaceState(null, '', '/');
  localStorage.clear();

  vi.mocked(api.fetchProjects).mockResolvedValue([
    {
      id: 'proj-1',
      name: 'Project One',
      rootPath: '/projects/a',
      prefixes: ['bdboard'],
      sessionCount: 0,
      activeSessionCount: 0,
      incompleteTicketCount: 0,
      sessions: [],
    } satisfies ProjectDto,
  ]);
  vi.mocked(api.fetchSessions).mockResolvedValue([] satisfies SessionDto[]);
  vi.mocked(api.fetchStatus).mockResolvedValue({
    lastRefreshAt: '2026-01-01T00:00:00.000Z',
    errors: [],
    projectCount: 1,
  } satisfies StatusDto);
  vi.mocked(api.fetchBoard).mockResolvedValue(boardWithCard);
  vi.mocked(api.fetchPendingDecisions).mockResolvedValue(
    [] satisfies PendingDecisionDto[],
  );
  vi.mocked(api.fetchChatAvailability).mockResolvedValue({
    availability: 'unavailable',
  } satisfies ChatAvailabilityDto);
  vi.mocked(api.fetchTicket).mockResolvedValue(sampleTicket);
  vi.mocked(api.fetchTicketComments).mockResolvedValue([] satisfies CommentDto[]);
  vi.mocked(api.fetchTunnel).mockResolvedValue({
    state: 'off',
    available: true,
    authEnabled: true,
  });
  vi.mocked(api.fetchAiQuota).mockRejectedValue(new Error('not configured'));
  vi.mocked(api.fetchBoardThresholdsConfig).mockResolvedValue({
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
}

export function renderApp() {
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
