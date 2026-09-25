import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSummaryDto } from '../api';

vi.mock('../api', () => ({
  fetchAllAgentRuns: vi.fn(),
}));

import { fetchAllAgentRuns } from '../api';
import { useActiveAgentRuns } from './useActiveAgentRuns';

const fetchAllAgentRunsMock = vi.mocked(fetchAllAgentRuns);

function makeRun(overrides: Partial<AgentRunSummaryDto> = {}): AgentRunSummaryDto {
  return {
    id: `run-${overrides.ticketId ?? 'x'}`,
    ticketId: 'bdboard-a',
    runner: 'claude-spawn',
    mode: 'spawn',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderActiveAgentRuns(enabled: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useActiveAgentRuns(enabled), { wrapper }), queryClient };
}

// bdboard-xuuz: 一括実行が「既に実行中のエージェントがあるカード」を対象外にする
// ための board 全体の run 一覧取得。useAllHarnessStatuses (useHarnessStatusData.ts)
// と同じ enabled ゲート・queryKey 固定・retry:false の形なので、テストの型もそちらに揃える。
describe('useActiveAgentRuns', () => {
  beforeEach(() => {
    fetchAllAgentRunsMock.mockReset();
  });

  it('only fetches while enabled', async () => {
    fetchAllAgentRunsMock.mockResolvedValue({ runs: [] });

    renderActiveAgentRuns(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchAllAgentRunsMock).not.toHaveBeenCalled();

    const { result } = renderActiveAgentRuns(true);
    await waitFor(() => expect(fetchAllAgentRunsMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.activeRunsQuery.isSuccess).toBe(true));
  });

  it('registers the agent-runs-active query under a shared queryKey', async () => {
    fetchAllAgentRunsMock.mockResolvedValue({ runs: [] });
    const { result, queryClient } = renderActiveAgentRuns(true);

    await waitFor(() => expect(result.current.activeRunsQuery.isSuccess).toBe(true));

    expect(
      queryClient.getQueryCache().find({ queryKey: ['agent-runs-active'] }),
    ).toBeDefined();
  });

  it('collects running and cancelling ticket ids, ignoring terminal and duplicate runs', async () => {
    fetchAllAgentRunsMock.mockResolvedValue({
      runs: [
        makeRun({ ticketId: 'bdboard-a', status: 'running' }),
        makeRun({ ticketId: 'bdboard-b', status: 'cancelling' }),
        makeRun({ ticketId: 'bdboard-c', status: 'succeeded' }),
        makeRun({ ticketId: 'bdboard-d', status: 'failed' }),
        makeRun({ ticketId: 'bdboard-e', status: 'cancelled' }),
        // A ticket can have more than one run in history; only the active one matters.
        makeRun({ ticketId: 'bdboard-a', status: 'succeeded' }),
      ],
    });
    const { result } = renderActiveAgentRuns(true);

    await waitFor(() => expect(result.current.activeRunsQuery.isSuccess).toBe(true));

    expect(result.current.runningTicketIds).toEqual(new Set(['bdboard-a', 'bdboard-b']));
  });

  it('returns an empty set while disabled', () => {
    fetchAllAgentRunsMock.mockResolvedValue({ runs: [makeRun()] });
    const { result } = renderActiveAgentRuns(false);

    expect(result.current.runningTicketIds.size).toBe(0);
    expect(result.current.activeRunsQuery.data).toBeUndefined();
  });

  it('does not retry agent-runs-active on failure (retry: false)', async () => {
    fetchAllAgentRunsMock.mockRejectedValue(new Error('boom'));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useActiveAgentRuns(true), { wrapper });

    await waitFor(() => expect(result.current.activeRunsQuery.isError).toBe(true));

    expect(fetchAllAgentRunsMock).toHaveBeenCalledTimes(1);
    expect(result.current.runningTicketIds.size).toBe(0);
  });
});
