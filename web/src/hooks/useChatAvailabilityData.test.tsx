import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAvailabilityDto } from '../api';

vi.mock('../api', () => ({
  fetchChatAvailability: vi.fn(),
}));

import { fetchChatAvailability } from '../api';
import { useChatAvailabilityData } from './useChatAvailabilityData';

const fetchChatAvailabilityMock = vi.mocked(fetchChatAvailability);

function renderChatAvailabilityData() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useChatAvailabilityData(), { wrapper }), queryClient };
}

describe('useChatAvailabilityData', () => {
  beforeEach(() => {
    fetchChatAvailabilityMock.mockReset();
  });

  it('registers the chat-availability query under the exact queryKey used by App.tsx', async () => {
    fetchChatAvailabilityMock.mockResolvedValue({ availability: 'available' });
    const { result, queryClient } = renderChatAvailabilityData();

    await waitFor(() => expect(result.current.chatAvailabilityQuery.isSuccess).toBe(true));

    expect(queryClient.getQueryCache().find({ queryKey: ['chat-availability'] })).toBeDefined();
  });

  it('treats "available" as chatAvailable', async () => {
    const dto: ChatAvailabilityDto = { availability: 'available' };
    fetchChatAvailabilityMock.mockResolvedValue(dto);
    const { result } = renderChatAvailabilityData();

    await waitFor(() => expect(result.current.chatAvailable).toBe(true));
  });

  it('treats "unknown" as chatAvailable too (auth not yet confirmed still lets chat open)', async () => {
    const dto: ChatAvailabilityDto = { availability: 'unknown' };
    fetchChatAvailabilityMock.mockResolvedValue(dto);
    const { result } = renderChatAvailabilityData();

    await waitFor(() => expect(result.current.chatAvailabilityQuery.data).toEqual(dto));

    expect(result.current.chatAvailable).toBe(true);
  });

  it('treats "unavailable" as not chatAvailable', async () => {
    const dto: ChatAvailabilityDto = { availability: 'unavailable' };
    fetchChatAvailabilityMock.mockResolvedValue(dto);
    const { result } = renderChatAvailabilityData();

    await waitFor(() => expect(result.current.chatAvailabilityQuery.data).toEqual(dto));

    expect(result.current.chatAvailable).toBe(false);
  });

  it('treats no data yet (query pending) as not chatAvailable', () => {
    fetchChatAvailabilityMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderChatAvailabilityData();

    expect(result.current.chatAvailable).toBe(false);
  });

  it('does not retry chat-availability on failure (retry: false, matching App.tsx)', async () => {
    fetchChatAvailabilityMock.mockRejectedValue(new Error('boom'));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useChatAvailabilityData(), { wrapper });

    await waitFor(() => expect(result.current.chatAvailabilityQuery.isError).toBe(true));

    expect(fetchChatAvailabilityMock).toHaveBeenCalledTimes(1);
  });
});
