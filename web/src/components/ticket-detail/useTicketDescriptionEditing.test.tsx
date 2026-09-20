import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, patchTicketDescription } from '../../api';
import { useTicketDescriptionEditing } from './useTicketDescriptionEditing';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    patchTicketDescription: vi.fn(),
  };
});

const patchTicketDescriptionMock = vi.mocked(patchTicketDescription);

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useTicketDescriptionEditing', () => {
  beforeEach(() => {
    patchTicketDescriptionMock.mockReset();
    patchTicketDescriptionMock.mockResolvedValue(undefined);
  });

  it('starts editing with the current description (empty when undefined)', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDescriptionEditing('bd-1', true, undefined),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartDescriptionEdit();
    });
    expect(result.current.descriptionEditing).toBe(true);
    expect(result.current.descriptionDraft).toBe('');
    expect(result.current.canSaveDescription).toBe(false);

    act(() => {
      result.current.setDescriptionDraft('New body');
    });
    expect(result.current.canSaveDescription).toBe(true);
  });

  it('does nothing when starting edit while hasData is false', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDescriptionEditing('bd-1', false, 'Existing'),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartDescriptionEdit();
    });
    expect(result.current.descriptionEditing).toBe(false);
  });

  it('saves and clears the edit state on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDescriptionEditing('bd-1', true, 'Existing'),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartDescriptionEdit();
      result.current.setDescriptionDraft('New body');
    });
    await act(async () => {
      result.current.handleSaveDescription();
    });

    await waitFor(() =>
      expect(patchTicketDescriptionMock).toHaveBeenCalledWith(
        'bd-1',
        'New body',
        'Existing',
      ),
    );
    await waitFor(() => expect(result.current.descriptionEditing).toBe(false));
    expect(result.current.descriptionDraft).toBe('');
  });

  it('does not submit when the draft is unchanged', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDescriptionEditing('bd-1', true, 'Existing'),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartDescriptionEdit();
    });
    act(() => {
      result.current.handleSaveDescription();
    });

    expect(patchTicketDescriptionMock).not.toHaveBeenCalled();
  });

  it('clears the edit state and refetches on a 409 conflict', async () => {
    patchTicketDescriptionMock.mockRejectedValue(
      new ApiError(409, 'description changed since read', {
        errorMessage: 'description changed since read',
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDescriptionEditing('bd-1', true, 'Existing'),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartDescriptionEdit();
      result.current.setDescriptionDraft('New body');
    });
    await act(async () => {
      result.current.handleSaveDescription();
    });

    await waitFor(() => expect(result.current.descriptionEditing).toBe(false));
    expect(result.current.descriptionDraft).toBe('');
  });

  it('reset() clears editing state regardless of pending drafts', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDescriptionEditing('bd-1', true, 'Existing'),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleStartDescriptionEdit();
      result.current.setDescriptionDraft('Some draft');
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.descriptionEditing).toBe(false);
    expect(result.current.descriptionDraft).toBe('');
  });
});
