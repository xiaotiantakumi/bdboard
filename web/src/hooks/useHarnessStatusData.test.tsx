import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllHarnessStatusDto } from '../api';

vi.mock('../api', () => ({
  fetchAllHarnessStatus: vi.fn(),
}));

import { fetchAllHarnessStatus } from '../api';
import { useHarnessStatusData } from './useHarnessStatusData';

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

function renderHarnessStatusData(view: Parameters<typeof useHarnessStatusData>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useHarnessStatusData(view), { wrapper }), queryClient };
}

describe('useHarnessStatusData', () => {
  beforeEach(() => {
    fetchAllHarnessStatusMock.mockReset();
  });

  it('is enabled only when view === "next", matching App.tsx', async () => {
    fetchAllHarnessStatusMock.mockResolvedValue(makeAllStatus());

    renderHarnessStatusData('merged');
    // Give any accidental fetch a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchAllHarnessStatusMock).not.toHaveBeenCalled();

    const { result } = renderHarnessStatusData('next');
    await waitFor(() => expect(fetchAllHarnessStatusMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.harnessStatusQuery.isSuccess).toBe(true));
  });

  it('registers the harness-status-all query under the exact queryKey used by App.tsx', async () => {
    fetchAllHarnessStatusMock.mockResolvedValue(makeAllStatus());
    const { result, queryClient } = renderHarnessStatusData('next');

    await waitFor(() => expect(result.current.harnessStatusQuery.isSuccess).toBe(true));

    expect(
      queryClient.getQueryCache().find({ queryKey: ['harness-status-all'] }),
    ).toBeDefined();
  });

  it('derives harnessStatuses keyed by projectId, carrying only packs/contract', async () => {
    const allStatus = makeAllStatus();
    fetchAllHarnessStatusMock.mockResolvedValue(allStatus);
    const { result } = renderHarnessStatusData('next');

    await waitFor(() => expect(result.current.harnessStatusQuery.data).toEqual(allStatus));

    expect(result.current.harnessStatuses.get('proj-1')).toEqual({
      packs: allStatus.projects[0].packs,
      contract: allStatus.projects[0].contract,
    });
  });

  it('returns an empty harnessStatuses map while disabled (not on the Next Up view)', () => {
    fetchAllHarnessStatusMock.mockResolvedValue(makeAllStatus());
    const { result } = renderHarnessStatusData('merged');

    expect(result.current.harnessStatuses.size).toBe(0);
    expect(result.current.harnessStatusQuery.data).toBeUndefined();
  });

  it('does not retry harness-status-all on failure (retry: false, matching App.tsx)', async () => {
    fetchAllHarnessStatusMock.mockRejectedValue(new Error('boom'));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useHarnessStatusData('next'), { wrapper });

    await waitFor(() => expect(result.current.harnessStatusQuery.isError).toBe(true));

    expect(fetchAllHarnessStatusMock).toHaveBeenCalledTimes(1);
  });
});
