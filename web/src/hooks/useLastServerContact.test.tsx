import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardStreamResult } from '../useBoardStream';
import { useLastServerContact } from './useLastServerContact';

const useBoardStreamMock = vi.fn<() => BoardStreamResult>(() => ({
  state: 'open',
  lastContactAtMs: 1_000,
}));

vi.mock('../useBoardStream', () => ({
  useBoardStream: () => useBoardStreamMock(),
}));

describe('useLastServerContact', () => {
  it('merges SSE contact with boardQuery.dataUpdatedAt using the latest timestamp', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useLastServerContact(5_000), { wrapper });

    expect(result.current.streamState).toBe('open');
    expect(result.current.lastContactAtMs).toBe(5_000);
  });

  it('treats react-query dataUpdatedAt 0 as no contact when SSE has not contacted yet', () => {
    useBoardStreamMock.mockReturnValueOnce({
      state: 'connecting',
      lastContactAtMs: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useLastServerContact(0), { wrapper });

    expect(result.current.lastContactAtMs).toBeUndefined();
  });
});
