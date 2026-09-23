import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDto } from '../api';

vi.mock('../api', () => ({
  fetchSessions: vi.fn(),
}));

import { fetchSessions } from '../api';
import { useSessionsData } from './useSessionsData';

const fetchSessionsMock = vi.mocked(fetchSessions);

function makeSession(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    sessionId: 'sess-1',
    pid: 111,
    cwd: '/repo',
    alive: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:05:00.000Z',
    liveness: 'active',
    ...overrides,
  };
}

function renderSessionsData() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useSessionsData(), { wrapper }), queryClient };
}

describe('useSessionsData', () => {
  beforeEach(() => {
    fetchSessionsMock.mockReset();
  });

  it('registers the sessions query under the exact queryKey used by App.tsx', async () => {
    fetchSessionsMock.mockResolvedValue([]);
    const { result, queryClient } = renderSessionsData();

    await waitFor(() => expect(result.current.sessionsQuery.isSuccess).toBe(true));

    expect(queryClient.getQueryCache().find({ queryKey: ['sessions'] })).toBeDefined();
  });

  it('counts only liveness "active" sessions as activeSessionCount, all as totalSessionCount', async () => {
    const sessions = [
      makeSession({ sessionId: 'a', liveness: 'active' }),
      makeSession({ sessionId: 'b', liveness: 'idle' }),
      makeSession({ sessionId: 'c', liveness: 'active' }),
      makeSession({ sessionId: 'd', liveness: 'dormant' }),
    ];
    fetchSessionsMock.mockResolvedValue(sessions);
    const { result } = renderSessionsData();

    await waitFor(() => expect(result.current.sessionsQuery.data).toEqual(sessions));

    expect(result.current.totalSessionCount).toBe(4);
    expect(result.current.activeSessionCount).toBe(2);
  });

  it('reports zero counts while the query has no data yet', () => {
    fetchSessionsMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderSessionsData();

    expect(result.current.totalSessionCount).toBe(0);
    expect(result.current.activeSessionCount).toBe(0);
  });
});
