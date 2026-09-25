import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllHarnessStatusDto } from '../api';

vi.mock('../api', () => ({
  fetchAllHarnessStatus: vi.fn(),
}));

import { fetchAllHarnessStatus } from '../api';
import { useAllHarnessStatuses } from './useHarnessStatusData';

const fetchAllHarnessStatusMock = vi.mocked(fetchAllHarnessStatus);

function makeAllStatus(): AllHarnessStatusDto {
  return {
    projects: [
      {
        projectId: 'proj-1',
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
        contract: { state: 'not-applicable' },
      },
    ],
  };
}

function renderAllHarnessStatuses(enabled: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useAllHarnessStatuses(enabled), { wrapper }), queryClient };
}

// bdboard-mkm1.3: this used to cover useHarnessStatusData(view), a wrapper that
// gated useAllHarnessStatuses on `view === 'next'`. That wrapper (and its only
// caller, NextUpView) was deleted with the Next Up view; useAllHarnessStatuses
// itself is unchanged and is still relied on by the bulk action bar's agent-run
// preflight (useBulkAgentRun.ts), so its `enabled` gating, queryKey, and
// harnessStatuses derivation stay covered directly here instead of indirectly
// through a `view` param that no longer exists.
describe('useAllHarnessStatuses', () => {
  beforeEach(() => {
    fetchAllHarnessStatusMock.mockReset();
  });

  it('only fetches while enabled', async () => {
    fetchAllHarnessStatusMock.mockResolvedValue(makeAllStatus());

    renderAllHarnessStatuses(false);
    // Give any accidental fetch a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchAllHarnessStatusMock).not.toHaveBeenCalled();

    const { result } = renderAllHarnessStatuses(true);
    await waitFor(() => expect(fetchAllHarnessStatusMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.harnessStatusQuery.isSuccess).toBe(true));
  });

  it('registers the harness-status-all query under a shared queryKey', async () => {
    fetchAllHarnessStatusMock.mockResolvedValue(makeAllStatus());
    const { result, queryClient } = renderAllHarnessStatuses(true);

    await waitFor(() => expect(result.current.harnessStatusQuery.isSuccess).toBe(true));

    expect(
      queryClient.getQueryCache().find({ queryKey: ['harness-status-all'] }),
    ).toBeDefined();
  });

  it('derives harnessStatuses keyed by projectId, carrying only packs/contract', async () => {
    const allStatus = makeAllStatus();
    fetchAllHarnessStatusMock.mockResolvedValue(allStatus);
    const { result } = renderAllHarnessStatuses(true);

    await waitFor(() => expect(result.current.harnessStatusQuery.data).toEqual(allStatus));

    expect(result.current.harnessStatuses.get('proj-1')).toEqual({
      packs: allStatus.projects[0].packs,
      contract: allStatus.projects[0].contract,
    });
  });

  it('returns an empty harnessStatuses map while disabled', () => {
    fetchAllHarnessStatusMock.mockResolvedValue(makeAllStatus());
    const { result } = renderAllHarnessStatuses(false);

    expect(result.current.harnessStatuses.size).toBe(0);
    expect(result.current.harnessStatusQuery.data).toBeUndefined();
  });

  it('does not retry harness-status-all on failure (retry: false)', async () => {
    fetchAllHarnessStatusMock.mockRejectedValue(new Error('boom'));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAllHarnessStatuses(true), { wrapper });

    await waitFor(() => expect(result.current.harnessStatusQuery.isError).toBe(true));

    expect(fetchAllHarnessStatusMock).toHaveBeenCalledTimes(1);
  });
});
