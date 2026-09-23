import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingDecisionDto } from '../api';

vi.mock('../api', () => ({
  fetchPendingDecisions: vi.fn(),
}));

const updateAppBadge = vi.fn();
vi.mock('../appBadge', () => ({
  updateAppBadge: (...args: unknown[]) => updateAppBadge(...args),
}));

import { fetchPendingDecisions } from '../api';
import { usePendingDecisionsData } from './usePendingDecisionsData';

const fetchPendingDecisionsMock = vi.mocked(fetchPendingDecisions);

function makeDecision(overrides: Partial<PendingDecisionDto> = {}): PendingDecisionDto {
  return {
    id: 'bdboard-1',
    kind: 'gate',
    projectId: 'proj-1',
    allowFreeform: false,
    ...overrides,
  };
}

function renderPendingDecisionsData() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => usePendingDecisionsData(), { wrapper }), queryClient };
}

describe('usePendingDecisionsData', () => {
  beforeEach(() => {
    fetchPendingDecisionsMock.mockReset();
    updateAppBadge.mockClear();
  });

  it('registers the pending-decisions query under the exact queryKey used by App.tsx', async () => {
    fetchPendingDecisionsMock.mockResolvedValue([]);
    const { result, queryClient } = renderPendingDecisionsData();

    await waitFor(() => expect(result.current.pendingDecisionsQuery.isSuccess).toBe(true));

    expect(queryClient.getQueryCache().find({ queryKey: ['pending-decisions'] })).toBeDefined();
  });

  it('derives pendingDecisionsById and pendingDecisionIds from the fetched decisions', async () => {
    const decisions = [
      makeDecision({ id: 'bdboard-1' }),
      makeDecision({ id: 'bdboard-2', kind: 'ticket' }),
    ];
    fetchPendingDecisionsMock.mockResolvedValue(decisions);
    const { result } = renderPendingDecisionsData();

    await waitFor(() => expect(result.current.pendingDecisionsQuery.data).toEqual(decisions));

    expect(result.current.pendingDecisionsById.get('bdboard-1')).toEqual(decisions[0]);
    expect(result.current.pendingDecisionsById.get('bdboard-2')).toEqual(decisions[1]);
    expect(result.current.pendingDecisionIds).toEqual(new Set(['bdboard-1', 'bdboard-2']));
  });

  it('drives the app badge count from the pending decisions length, zero before data arrives', async () => {
    fetchPendingDecisionsMock.mockResolvedValue([makeDecision(), makeDecision({ id: 'bdboard-2' })]);
    renderPendingDecisionsData();

    // Before the query resolves, useAppBadge sees `undefined` -> badge count 0.
    expect(updateAppBadge).toHaveBeenCalledWith(0);

    await waitFor(() => expect(updateAppBadge).toHaveBeenCalledWith(2));
  });

  it('returns empty maps/sets while the query has no data yet', () => {
    fetchPendingDecisionsMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderPendingDecisionsData();

    expect(result.current.pendingDecisionsById.size).toBe(0);
    expect(result.current.pendingDecisionIds.size).toBe(0);
  });
});
