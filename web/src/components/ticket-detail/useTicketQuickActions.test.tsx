import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postTicketQuickAction } from '../../api';
import { useTicketQuickActions } from './useTicketQuickActions';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    postTicketQuickAction: vi.fn(),
    postTicketQuickActionUndo: vi.fn(),
  };
});

const postTicketQuickActionMock = vi.mocked(postTicketQuickAction);

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useTicketQuickActions', () => {
  beforeEach(() => {
    postTicketQuickActionMock.mockReset();
    postTicketQuickActionMock.mockResolvedValue(undefined);
  });

  it('derives canRaisePriority / canLowerPriority from the priority boundaries', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ priority }: { priority: number }) =>
        useTicketQuickActions('bd-1', { priority }, null),
      { wrapper: createWrapper(queryClient), initialProps: { priority: 0 } },
    );

    expect(result.current.canRaisePriority).toBe(false);
    expect(result.current.canLowerPriority).toBe(true);

    rerender({ priority: 4 });
    expect(result.current.canRaisePriority).toBe(true);
    expect(result.current.canLowerPriority).toBe(false);
  });

  it('does nothing when confirming without a pending confirmingQuickAction', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketQuickActions('bd-1', { priority: 2 }, null),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleConfirmQuickAction();
    });

    expect(postTicketQuickActionMock).not.toHaveBeenCalled();
  });

  it('submits the confirmed action and clears confirmingQuickAction on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketQuickActions('bd-1', { priority: 2 }, null),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setConfirmingQuickAction({ kind: 'claim' });
    });
    expect(result.current.confirmingQuickAction).toEqual({ kind: 'claim' });

    await act(async () => {
      result.current.handleConfirmQuickAction();
    });

    await waitFor(() =>
      expect(postTicketQuickActionMock).toHaveBeenCalledWith('bd-1', { action: 'claim' }),
    );
    await waitFor(() => expect(result.current.confirmingQuickAction).toBe(null));
  });

  it('surfaces the mutation error', async () => {
    postTicketQuickActionMock.mockRejectedValue(new Error('network down'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketQuickActions('bd-1', { priority: 2 }, null),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setConfirmingQuickAction({ kind: 'close' });
    });
    await act(async () => {
      result.current.handleConfirmQuickAction();
    });

    await waitFor(() => expect(result.current.mutationError).not.toBe(null));
  });

  it('reset() clears confirmation and defer/close draft state', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketQuickActions('bd-1', { priority: 2 }, null),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setConfirmingQuickAction({ kind: 'close' });
      result.current.setCloseReason('reason');
      result.current.setCustomDeferDate('2099-01-01');
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.confirmingQuickAction).toBe(null);
    expect(result.current.closeReason).toBe('');
    expect(result.current.customDeferDate).toBe('');
  });
});
