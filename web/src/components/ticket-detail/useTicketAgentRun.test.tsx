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
    const { result } = renderHook(() => useTicketAgentRun('bd-1', undefined), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.runStartDisabled.disabled).toBe(true);
    expect(result.current.harnessRunBlockReason).toBe(null);
  });

  it('derives runStartDisabled from the loaded ticket via computeRunStartDisabled', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTicketAgentRun('bd-1', ticket), {
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
    const { result } = renderHook(() => useTicketAgentRun('bd-1', ticket), {
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
    const { result } = renderHook(() => useTicketAgentRun('bd-1', ticket), {
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
    const { result } = renderHook(() => useTicketAgentRun('bd-1', ticket), {
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
});
