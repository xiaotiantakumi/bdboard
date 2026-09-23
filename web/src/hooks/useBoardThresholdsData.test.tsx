import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardThresholdsConfigDto } from '../api';

vi.mock('../api', () => ({
  fetchBoardThresholdsConfig: vi.fn(),
}));

import { fetchBoardThresholdsConfig } from '../api';
import { useBoardThresholdsData } from './useBoardThresholdsData';

const fetchBoardThresholdsConfigMock = vi.mocked(fetchBoardThresholdsConfig);

function makeConfig(overrides: Partial<BoardThresholdsConfigDto> = {}): BoardThresholdsConfigDto {
  return {
    stalledAfterMs: 86_400_000,
    livenessActiveMs: 60_000,
    livenessIdleMs: 300_000,
    livenessStaleMs: 1_800_000,
    inProgressWipLimit: null,
    inProgressWipLimitByProject: {},
    version: '1',
    defaults: {
      stalledAfterMs: 86_400_000,
      livenessActiveMs: 60_000,
      livenessIdleMs: 300_000,
      livenessStaleMs: 1_800_000,
      inProgressWipLimit: null,
      inProgressWipLimitByProject: {},
    },
    ...overrides,
  };
}

function renderBoardThresholdsData() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useBoardThresholdsData(), { wrapper }), queryClient };
}

describe('useBoardThresholdsData', () => {
  beforeEach(() => {
    fetchBoardThresholdsConfigMock.mockReset();
  });

  it('registers the board-thresholds-config query under the exact queryKey used by App.tsx', async () => {
    fetchBoardThresholdsConfigMock.mockResolvedValue(makeConfig());
    const { result, queryClient } = renderBoardThresholdsData();

    await waitFor(() => expect(result.current.boardThresholdsQuery.isSuccess).toBe(true));

    expect(
      queryClient.getQueryCache().find({ queryKey: ['board-thresholds-config'] }),
    ).toBeDefined();
  });

  it('returns {} for wipLimitsOverrides before data arrives', () => {
    fetchBoardThresholdsConfigMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderBoardThresholdsData();

    expect(result.current.wipLimitsOverrides).toEqual({});
  });

  it('omits inProgressWipLimit when the config value is null, but keeps inProgressWipLimitByProject', async () => {
    fetchBoardThresholdsConfigMock.mockResolvedValue(
      makeConfig({ inProgressWipLimit: null, inProgressWipLimitByProject: { 'proj-1': 3 } }),
    );
    const { result } = renderBoardThresholdsData();

    await waitFor(() => expect(result.current.boardThresholdsQuery.isSuccess).toBe(true));

    expect(result.current.wipLimitsOverrides).toEqual({
      inProgressWipLimitByProject: { 'proj-1': 3 },
    });
    expect('inProgressWipLimit' in result.current.wipLimitsOverrides).toBe(false);
  });

  it('includes inProgressWipLimit when the config value is a number', async () => {
    fetchBoardThresholdsConfigMock.mockResolvedValue(
      makeConfig({ inProgressWipLimit: 5, inProgressWipLimitByProject: {} }),
    );
    const { result } = renderBoardThresholdsData();

    await waitFor(() => expect(result.current.boardThresholdsQuery.isSuccess).toBe(true));

    expect(result.current.wipLimitsOverrides).toEqual({
      inProgressWipLimit: 5,
      inProgressWipLimitByProject: {},
    });
  });

  it('does not retry board-thresholds-config on failure (retry: false, matching App.tsx)', async () => {
    fetchBoardThresholdsConfigMock.mockRejectedValue(new Error('boom'));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useBoardThresholdsData(), { wrapper });

    await waitFor(() => expect(result.current.boardThresholdsQuery.isError).toBe(true));

    expect(fetchBoardThresholdsConfigMock).toHaveBeenCalledTimes(1);
  });
});
