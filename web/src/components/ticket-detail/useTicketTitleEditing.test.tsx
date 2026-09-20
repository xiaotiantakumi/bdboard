import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, patchTicketTitle } from '../../api';
import { useTicketTitleEditing } from './useTicketTitleEditing';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    patchTicketTitle: vi.fn(),
  };
});

const patchTicketTitleMock = vi.mocked(patchTicketTitle);

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useTicketTitleEditing', () => {
  beforeEach(() => {
    patchTicketTitleMock.mockReset();
    patchTicketTitleMock.mockResolvedValue(undefined);
  });

  it('starts editing with the current title and enables save once changed', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketTitleEditing('bd-1', 'Original title'),
      { wrapper: createWrapper(queryClient) },
    );

    expect(result.current.titleEditing).toBe(false);
    act(() => {
      result.current.handleStartTitleEdit();
    });
    expect(result.current.titleEditing).toBe(true);
    expect(result.current.titleDraft).toBe('Original title');
    expect(result.current.canSaveTitle).toBe(false);

    act(() => {
      result.current.setTitleDraft('Updated title');
    });
    expect(result.current.canSaveTitle).toBe(true);
  });

  it('does nothing when starting edit before the ticket has loaded', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketTitleEditing('bd-1', undefined),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartTitleEdit();
    });
    expect(result.current.titleEditing).toBe(false);
  });

  it('saves and clears the edit state on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketTitleEditing('bd-1', 'Original title'),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartTitleEdit();
      result.current.setTitleDraft('Updated title');
    });
    await act(async () => {
      result.current.handleSaveTitle();
    });

    await waitFor(() =>
      expect(patchTicketTitleMock).toHaveBeenCalledWith(
        'bd-1',
        'Updated title',
        'Original title',
      ),
    );
    await waitFor(() => expect(result.current.titleEditing).toBe(false));
    expect(result.current.titleDraft).toBe('');
  });

  it('clears the edit state and surfaces the error on a plain failure', async () => {
    patchTicketTitleMock.mockRejectedValue(new Error('network down'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketTitleEditing('bd-1', 'Original title'),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartTitleEdit();
      result.current.setTitleDraft('Updated title');
    });
    await act(async () => {
      result.current.handleSaveTitle();
    });

    await waitFor(() => expect(result.current.error).not.toBe(null));
    expect(result.current.titleEditing).toBe(true);
  });

  it('clears the edit state and refetches on a 409 conflict', async () => {
    patchTicketTitleMock.mockRejectedValue(
      new ApiError(409, 'title changed since read', {
        errorMessage: 'title changed since read',
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketTitleEditing('bd-1', 'Original title'),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartTitleEdit();
      result.current.setTitleDraft('Updated title');
    });
    await act(async () => {
      result.current.handleSaveTitle();
    });

    await waitFor(() => expect(result.current.titleEditing).toBe(false));
    expect(result.current.titleDraft).toBe('');
  });

  it('reset() clears editing state regardless of pending drafts', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketTitleEditing('bd-1', 'Original title'),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartTitleEdit();
      result.current.setTitleDraft('Some draft');
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.titleEditing).toBe(false);
    expect(result.current.titleDraft).toBe('');
  });
});
