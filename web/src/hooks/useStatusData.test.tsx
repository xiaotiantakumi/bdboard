import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusDto } from '../api';
import { getBoardTimeZone, resetBoardTimeZoneForTests } from '../boardTimeZone';

vi.mock('../api', () => ({
  fetchStatus: vi.fn(),
}));

import { fetchStatus } from '../api';
import { useStatusData } from './useStatusData';

const fetchStatusMock = vi.mocked(fetchStatus);

function makeStatus(overrides: Partial<StatusDto> = {}): StatusDto {
  return {
    lastRefreshAt: '2026-09-24T00:00:00.000Z',
    errors: [],
    projectCount: 1,
    boardTimeZone: null,
    ...overrides,
  };
}

function renderStatusData() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useStatusData(), { wrapper }), queryClient };
}

describe('useStatusData', () => {
  beforeEach(() => {
    fetchStatusMock.mockReset();
    resetBoardTimeZoneForTests();
  });

  afterEach(() => {
    resetBoardTimeZoneForTests();
  });

  it('registers the status query under the exact queryKey used by App.tsx', async () => {
    fetchStatusMock.mockResolvedValue(makeStatus());
    const { result, queryClient } = renderStatusData();

    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));

    expect(queryClient.getQueryCache().find({ queryKey: ['status'] })).toBeDefined();
  });

  it('exposes lastRefreshAt and statusErrors from the fetched status', async () => {
    const status = makeStatus({
      lastRefreshAt: '2026-09-24T12:00:00.000Z',
      errors: [{ kind: 'harness', projectId: 'proj-1', detail: 'boom' }],
    });
    fetchStatusMock.mockResolvedValue(status);
    const { result } = renderStatusData();

    await waitFor(() => expect(result.current.statusQuery.data).toEqual(status));

    expect(result.current.lastRefreshAt).toBe('2026-09-24T12:00:00.000Z');
    expect(result.current.statusErrors).toEqual([
      { kind: 'harness', projectId: 'proj-1', detail: 'boom' },
    ]);
  });

  it('falls back to an empty statusErrors array and undefined lastRefreshAt before data arrives', () => {
    fetchStatusMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderStatusData();

    expect(result.current.lastRefreshAt).toBeUndefined();
    expect(result.current.statusErrors).toEqual([]);
  });

  it('propagates a non-null boardTimeZone override into getBoardTimeZone via the sync effect', async () => {
    fetchStatusMock.mockResolvedValue(makeStatus({ boardTimeZone: 'Asia/Tokyo' }));
    const { result } = renderStatusData();

    await waitFor(() => expect(result.current.statusQuery.data?.boardTimeZone).toBe('Asia/Tokyo'));
    await waitFor(() => expect(getBoardTimeZone()).toBe('Asia/Tokyo'));
  });

  it('does not override the board time zone when boardTimeZone is null', async () => {
    fetchStatusMock.mockResolvedValue(makeStatus({ boardTimeZone: null }));
    const { result } = renderStatusData();

    await waitFor(() => expect(result.current.statusQuery.data).toBeDefined());

    expect(getBoardTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
