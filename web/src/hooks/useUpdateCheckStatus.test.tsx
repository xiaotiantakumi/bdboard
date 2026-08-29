import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCheckDto } from '../api';
import { useCachedUpdateCheck, useUpdateCheckQuery } from './useUpdateCheckStatus';

const STORAGE_KEY = 'bdboard.updateCheck.v1';
const fetchUpdateCheck = vi.fn<() => Promise<UpdateCheckDto>>();

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchUpdateCheck: () => fetchUpdateCheck(),
}));

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useUpdateCheckStatus', () => {
  beforeEach(() => {
    fetchUpdateCheck.mockReset();
    localStorage.clear();
  });

  describe('useCachedUpdateCheck', () => {
    it('does not call fetchUpdateCheck when enabled is false', () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      renderHook(() => useCachedUpdateCheck(), {
        wrapper: createWrapper(queryClient),
      });

      expect(fetchUpdateCheck).not.toHaveBeenCalled();
    });

    it('uses valid data from localStorage as initial data', () => {
      const stored: UpdateCheckDto = {
        state: 'update-available',
        currentVersion: '1.0.0',
        latestVersion: 'v2.0.0',
        releaseUrl: 'https://example.com/release',
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const { result } = renderHook(() => useCachedUpdateCheck(), {
        wrapper: createWrapper(queryClient),
      });

      expect(result.current).toEqual(stored);
      expect(fetchUpdateCheck).not.toHaveBeenCalled();
    });

    it.each([
      ['invalid JSON', '{not json'],
      ['missing fields', JSON.stringify({ state: 'update-available' })],
      ['unknown state', JSON.stringify({ state: 'bogus', currentVersion: '1.0.0' })],
    ])('ignores %s in localStorage', (_label, raw) => {
      localStorage.setItem(STORAGE_KEY, raw);

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const { result } = renderHook(() => useCachedUpdateCheck(), {
        wrapper: createWrapper(queryClient),
      });

      expect(result.current).toBeUndefined();
      expect(fetchUpdateCheck).not.toHaveBeenCalled();
    });
  });

  describe('useUpdateCheckQuery', () => {
    it('persists successful fetch to localStorage', async () => {
      const dto: UpdateCheckDto = {
        state: 'up-to-date',
        currentVersion: '1.0.0',
      };
      fetchUpdateCheck.mockResolvedValue(dto);

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      renderHook(() => useUpdateCheckQuery(), {
        wrapper: createWrapper(queryClient),
      });

      await waitFor(() => {
        expect(fetchUpdateCheck).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(dto));
      });
    });
  });
});
