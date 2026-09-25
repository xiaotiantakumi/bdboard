import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelAgentRun,
  fetchAgentRun,
  fetchProjectHarnessStatus,
  fetchTicketRuns,
  startTicketRun,
  type AgentRunSummaryDto,
  type ProjectHarnessStatusDto,
  type TicketDetailDto,
} from '../../api';
import { useTicketAgentRun } from './useTicketAgentRun';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    cancelAgentRun: vi.fn(),
    fetchAgentRun: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
    fetchTicketRuns: vi.fn(),
    startTicketRun: vi.fn(),
  };
});

const cancelAgentRunMock = vi.mocked(cancelAgentRun);
const fetchAgentRunMock = vi.mocked(fetchAgentRun);
const fetchProjectHarnessStatusMock = vi.mocked(fetchProjectHarnessStatus);
const fetchTicketRunsMock = vi.mocked(fetchTicketRuns);
const startTicketRunMock = vi.mocked(startTicketRun);

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const harnessStatusOk: ProjectHarnessStatusDto = {
  packs: [
    {
      name: 'bdboard-harness',
      availableVersion: '1.0.0',
      installedVersion: '1.0.0',
      drift: false,
      hooksState: 'ok',
      missingHooks: [],
    },
  ],
  contract: {
    state: 'ok',
    verify: 'npm run verify',
    prFlow: 'pr',
    mainBranch: 'main',
    models: null,
    expiredExcludeCount: 0,
    modelExclusionWarnings: [],
  },
};

const ticket: TicketDetailDto = {
  id: 'bd-1',
  projectId: 'proj-1',
  title: 'テストチケット',
  status: 'open',
  priority: 2,
  issueType: 'task',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  commentCount: 0,
  dependencies: [],
  blockedBy: [],
  blocks: [],
  sessionLinks: [],
  models: [],
  children: [],
};

describe('useTicketAgentRun', () => {
  beforeEach(() => {
    cancelAgentRunMock.mockReset();
    fetchAgentRunMock.mockReset();
    fetchProjectHarnessStatusMock.mockReset();
    fetchTicketRunsMock.mockReset();
    startTicketRunMock.mockReset();

    fetchProjectHarnessStatusMock.mockResolvedValue(harnessStatusOk);
    fetchTicketRunsMock.mockResolvedValue({ runs: [] });
  });

  it('disables the run when data is not loaded yet', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTicketAgentRun('bd-1', undefined, undefined), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.runStartDisabled.disabled).toBe(true);
    expect(result.current.harnessRunBlockReason).toBe(null);
  });

  it('derives runStartDisabled from the loaded ticket via computeRunStartDisabled', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTicketAgentRun('bd-1', ticket, undefined), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.runStartDisabled.disabled).toBe(false));
  });

  it('starting a run sets activeRunId/activeRunMeta, clears confirmingAgentRun, and reflects the polled status', async () => {
    startTicketRunMock.mockResolvedValue({
      runId: 'run-1',
      ticketId: 'bd-1',
      status: 'pending',
      worktreePath: '/tmp/wt',
      branchName: 'bd/bd-1',
      reused: false,
    });
    fetchAgentRunMock.mockResolvedValue({
      id: 'run-1',
      ticketId: 'bd-1',
      runner: 'claude',
      mode: 'spawn',
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00Z',
      log: '',
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // bdboard-xuuz: 一括実行の「既に実行中のエージェントがあるカード」判定が使う
    // board 全体の run 一覧も、この画面からの実行開始で stale になることを確認する。
    queryClient.setQueryData(['agent-runs-active'], { runs: [] });
    const { result } = renderHook(() => useTicketAgentRun('bd-1', ticket, undefined), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.setConfirmingAgentRun(true);
    });
    expect(result.current.confirmingAgentRun).toBe(true);

    await act(async () => {
      result.current.startRunMutation.mutate();
    });

    await waitFor(() => expect(result.current.confirmingAgentRun).toBe(false));
    expect(result.current.activeRunMeta).toEqual({
      worktreePath: '/tmp/wt',
      branchName: 'bd/bd-1',
      reused: false,
    });
    expect(startTicketRunMock).toHaveBeenCalledWith('bd-1');
    expect(queryClient.getQueryState(['agent-runs-active'])?.isInvalidated).toBe(true);

    await waitFor(() =>
      expect(result.current.polledRunDetail?.status).toBe('succeeded'),
    );
  });

  it('cancelRunMutation cancels the active run id', async () => {
    startTicketRunMock.mockResolvedValue({
      runId: 'run-2',
      ticketId: 'bd-1',
      status: 'pending',
      worktreePath: '/tmp/wt',
      branchName: 'bd/bd-1',
      reused: true,
    });
    fetchAgentRunMock.mockResolvedValue({
      id: 'run-2',
      ticketId: 'bd-1',
      runner: 'claude',
      mode: 'spawn',
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00Z',
      log: '',
    });
    cancelAgentRunMock.mockResolvedValue({ runId: 'run-2', status: 'cancelled' });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTicketAgentRun('bd-1', ticket, undefined), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      result.current.startRunMutation.mutate();
    });
    await waitFor(() => expect(result.current.polledRunDetail?.status).toBe('succeeded'));

    await act(async () => {
      result.current.cancelRunMutation.mutate();
    });

    await waitFor(() => expect(cancelAgentRunMock).toHaveBeenCalledWith('run-2'));
  });

  it('reset() clears confirmation, active run, and history selection state', async () => {
    startTicketRunMock.mockResolvedValue({
      runId: 'run-3',
      ticketId: 'bd-1',
      status: 'pending',
      worktreePath: '/tmp/wt',
      branchName: 'bd/bd-1',
      reused: false,
    });
    fetchAgentRunMock.mockResolvedValue({
      id: 'run-3',
      ticketId: 'bd-1',
      runner: 'claude',
      mode: 'spawn',
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00Z',
      log: '',
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTicketAgentRun('bd-1', ticket, undefined), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      result.current.startRunMutation.mutate();
    });
    await waitFor(() => expect(result.current.activeRunMeta).not.toBe(null));

    act(() => {
      result.current.setSelectedHistoryRunId('run-old');
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.confirmingAgentRun).toBe(false);
    expect(result.current.activeRunMeta).toBe(null);
    expect(result.current.polledRunDetail).toBe(null);
    expect(result.current.selectedHistoryRunId).toBe(null);
  });

  // bdboard-sso1.5 PR-L: Opus レビューで発見された回帰の再発防止テスト。
  // 元の実装 (TicketDetailPanel.tsx が全状態を1つの useEffect で管理していた頃) は
  // 「ticketId 変更時のリセット」→「activeRunFromList から activeRunId への同期」の
  // 順で effect が発火することに暗黙に依存していた。抽出時にこの順序が偶然逆転し、
  // ['ticket-runs', ticketId] のキャッシュに実行中 run が既にある状態でこのフックが
  // マウントされると、同期effectがセットした activeRunId を直後にリセットeffectが
  // null へ巻き戻し、ポーリングが一切始まらない (=実行中の表示が消える) という
  // リグレッションがあった。このテストは「マウント前からキャッシュが温まっている」
  // 状況を再現し、ポーリング (fetchAgentRun 呼び出し) が実際に始まることを確認する。
  it('restores and polls an active run that was already cached in ticket-runs before mount', async () => {
    const warmRun: AgentRunSummaryDto = {
      id: 'run-warm',
      ticketId: 'bd-1',
      runner: 'claude',
      mode: 'spawn',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
    };
    fetchTicketRunsMock.mockResolvedValue({ runs: [warmRun] });
    fetchAgentRunMock.mockResolvedValue({
      id: 'run-warm',
      ticketId: 'bd-1',
      runner: 'claude',
      mode: 'spawn',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      log: '',
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // マウント前にキャッシュを温めておく — 「そのチケットを最近開いていて、
    // gcTime 内に再訪した」状況の再現。これで ticket-runs のデータが初回レンダーから
    // 同期的に手に入り、リセットeffectと同期effectが同一コミットで走る。
    queryClient.setQueryData(['ticket-runs', 'bd-1'], { runs: [warmRun] });

    const { result } = renderHook(() => useTicketAgentRun('bd-1', ticket, undefined), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(fetchAgentRunMock).toHaveBeenCalledWith('run-warm'));
    await waitFor(() => expect(result.current.polledRunDetail?.status).toBe('running'));
    expect(result.current.hasActiveRun).toBe(true);
  });
});
