import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postTicketComment } from '../../api';
import { useTicketComment } from './useTicketComment';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    postTicketComment: vi.fn(),
  };
});

const postTicketCommentMock = vi.mocked(postTicketComment);

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useTicketComment', () => {
  beforeEach(() => {
    postTicketCommentMock.mockReset();
    postTicketCommentMock.mockResolvedValue(undefined);
  });

  it('disables submit until the trimmed text is non-empty', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTicketComment('bd-1'), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.canSubmitComment).toBe(false);

    act(() => {
      result.current.setCommentText('   ');
    });
    expect(result.current.canSubmitComment).toBe(false);

    act(() => {
      result.current.setCommentText('  hello  ');
    });
    expect(result.current.canSubmitComment).toBe(true);
  });

  it('posts the trimmed text and clears it on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTicketComment('bd-1'), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.setCommentText('  hello  ');
    });
    await act(async () => {
      result.current.mutation.mutate();
    });

    await waitFor(() =>
      expect(postTicketCommentMock).toHaveBeenCalledWith('bd-1', 'hello'),
    );
    await waitFor(() => expect(result.current.commentText).toBe(''));
  });

  it('surfaces the mutation error without clearing the draft', async () => {
    postTicketCommentMock.mockRejectedValue(new Error('network down'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTicketComment('bd-1'), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.setCommentText('hello');
    });
    await act(async () => {
      result.current.mutation.mutate();
    });

    await waitFor(() => expect(result.current.mutation.error).not.toBe(null));
    expect(result.current.commentText).toBe('hello');
  });

  it('reset() clears the draft', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTicketComment('bd-1'), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.setCommentText('draft');
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.commentText).toBe('');
  });
});
