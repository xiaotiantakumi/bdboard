import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTicketLabel, postTicketAddLabel } from '../../api';
import { useTicketLabels } from './useTicketLabels';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    postTicketAddLabel: vi.fn(),
    deleteTicketLabel: vi.fn(),
  };
});

const postTicketAddLabelMock = vi.mocked(postTicketAddLabel);
const deleteTicketLabelMock = vi.mocked(deleteTicketLabel);

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useTicketLabels', () => {
  beforeEach(() => {
    postTicketAddLabelMock.mockReset();
    deleteTicketLabelMock.mockReset();
    postTicketAddLabelMock.mockResolvedValue(undefined);
    deleteTicketLabelMock.mockResolvedValue(undefined);
  });

  it('suggests available labels not already applied, filtered by the query', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketLabels('bd-1', ['bug'], ['bug', 'feature', 'flaky-test']),
      { wrapper: createWrapper(queryClient) },
    );

    expect(result.current.labelSuggestions).toEqual(['feature', 'flaky-test']);

    act(() => {
      result.current.setLabelInputQuery('FEAT');
    });
    expect(result.current.labelSuggestions).toEqual(['feature']);
  });

  it('canSubmitLabel is false for an empty or already-applied label', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketLabels('bd-1', ['bug'], ['bug', 'feature']),
      { wrapper: createWrapper(queryClient) },
    );

    expect(result.current.canSubmitLabel).toBe(false);

    act(() => {
      result.current.setLabelInputQuery('bug');
    });
    expect(result.current.canSubmitLabel).toBe(false);

    act(() => {
      result.current.setLabelInputQuery('new-label');
    });
    expect(result.current.canSubmitLabel).toBe(true);
  });

  it('adds a trimmed label and clears the input query on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketLabels('bd-1', ['bug'], []),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setLabelInputQuery('  new-label  ');
    });
    await act(async () => {
      result.current.handleAddLabel(result.current.trimmedLabelInput);
    });

    await waitFor(() =>
      expect(postTicketAddLabelMock).toHaveBeenCalledWith('bd-1', 'new-label'),
    );
    await waitFor(() => expect(result.current.labelInputQuery).toBe(''));
  });

  it('does not submit an empty label or one already applied', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketLabels('bd-1', ['bug'], []),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.handleAddLabel('   ');
    });
    act(() => {
      result.current.handleAddLabel('bug');
    });

    expect(postTicketAddLabelMock).not.toHaveBeenCalled();
  });

  it('removes a label via handleRemoveLabel', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketLabels('bd-1', ['bug'], []),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.handleRemoveLabel('bug');
    });

    await waitFor(() =>
      expect(deleteTicketLabelMock).toHaveBeenCalledWith('bd-1', 'bug'),
    );
  });

  it('surfaces an error from either mutation and keeps labelMutationPending combined', async () => {
    postTicketAddLabelMock.mockRejectedValue(new Error('network down'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketLabels('bd-1', [], []),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.handleAddLabel('broken');
    });

    await waitFor(() => expect(result.current.error).not.toBe(null));
    expect(result.current.labelMutationPending).toBe(false);
  });

  it('reset() clears the label input query', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketLabels('bd-1', [], []),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setLabelInputQuery('some draft');
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.labelInputQuery).toBe('');
  });
});
