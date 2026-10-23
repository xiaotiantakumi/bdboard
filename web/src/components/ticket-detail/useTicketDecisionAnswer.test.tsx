import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  postTicketDecision,
  type BoardViewDto,
  type PendingDecisionDto,
} from '../../api';
import { useTicketDecisionAnswer } from './useTicketDecisionAnswer';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    postTicketDecision: vi.fn(),
  };
});

const postTicketDecisionMock = vi.mocked(postTicketDecision);

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const pendingDecision: PendingDecisionDto = {
  id: 'gate-1',
  kind: 'gate',
  projectId: 'proj-1',
  question: '続けますか?',
  options: [{ value: 'yes', label: 'はい' }],
  allowFreeform: true,
};

describe('useTicketDecisionAnswer', () => {
  beforeEach(() => {
    postTicketDecisionMock.mockReset();
    postTicketDecisionMock.mockResolvedValue({ kind: 'ticket', closed: true });
  });

  it('canSubmitDecision requires a choice or non-empty freeform text', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDecisionAnswer('bd-1', pendingDecision),
      { wrapper: createWrapper(queryClient) },
    );

    expect(result.current.canSubmitDecision).toBe(false);

    act(() => {
      result.current.setFreeformText('  ');
    });
    expect(result.current.canSubmitDecision).toBe(false);

    act(() => {
      result.current.setSelectedChoice('yes');
    });
    expect(result.current.canSubmitDecision).toBe(true);
  });

  it('submits the choice, records submittedDecision, and clears the answer fields', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDecisionAnswer('bd-1', pendingDecision),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedChoice('yes');
    });

    await act(async () => {
      result.current.decisionMutation.mutate(undefined);
    });

    await waitFor(() =>
      expect(postTicketDecisionMock).toHaveBeenCalledWith('gate-1', { choice: 'yes' }),
    );
    await waitFor(() =>
      expect(result.current.submittedDecision).toMatchObject({
        decisionId: 'gate-1',
        choiceLabel: 'はい',
      }),
    );
    expect(result.current.selectedChoice).toBe(undefined);
    expect(result.current.freeformText).toBe('');
  });

  it('reset({ clearSubmittedDecision: true }) clears submittedDecision; without it, keeps it', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDecisionAnswer('bd-1', pendingDecision),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedChoice('yes');
    });
    await act(async () => {
      result.current.decisionMutation.mutate(undefined);
    });
    await waitFor(() => expect(result.current.submittedDecision).not.toBe(null));

    act(() => {
      result.current.reset();
    });
    expect(result.current.submittedDecision).not.toBe(null);

    act(() => {
      result.current.reset({ clearSubmittedDecision: true });
    });
    expect(result.current.submittedDecision).toBe(null);
  });

  function boardWithAwaiting(ids: string[]): BoardViewDto {
    const card = (id: string) => ({ ticket: { id } }) as never;
    const board = {
      lanes: { awaiting_human: ids.map(card), ready: [card('other')] },
      cardCount: ids.length + 1,
      closedTotal: 0,
      truncatedClosedIds: [],
    };
    return { mode: 'merged', generatedAt: '', projects: [], merged: board };
  }

  it('on success removes the card from the board cache, closes the panel, and notifies', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['board', 'merged', '', undefined], boardWithAwaiting(['gate-1', 'x']));
    queryClient.setQueryData(['pending-decisions'], [pendingDecision]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const onClose = vi.fn();
    const notify = vi.fn();
    const { result } = renderHook(
      () => useTicketDecisionAnswer('bd-1', pendingDecision, { onClose, notify }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.decisionMutation.mutate({ freeform: 'OK' });
    });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith('OK で回答しました');
    const cached = queryClient.getQueryData<BoardViewDto>(['board', 'merged', '', undefined]);
    expect(cached?.merged?.lanes['awaiting_human']?.map((c) => c.ticket.id)).toEqual(['x']);
    expect(cached?.merged?.cardCount).toBe(2);
    expect(queryClient.getQueryData(['pending-decisions'])).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['board'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pending-decisions'] });
  });

  it('truncates a long answer in the notification', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const notify = vi.fn();
    const { result } = renderHook(
      () => useTicketDecisionAnswer('bd-1', pendingDecision, { notify }),
      { wrapper: createWrapper(queryClient) },
    );
    await act(async () => {
      result.current.decisionMutation.mutate({ freeform: 'a'.repeat(100) });
    });
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith(`${'a'.repeat(30)}… で回答しました`);
  });

  it('on error keeps the panel open, leaves the board cache alone, and does not notify', async () => {
    postTicketDecisionMock.mockRejectedValue(new Error('boom'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['board', 'merged', '', undefined], boardWithAwaiting(['gate-1']));
    const onClose = vi.fn();
    const notify = vi.fn();
    const { result } = renderHook(
      () => useTicketDecisionAnswer('bd-1', pendingDecision, { onClose, notify }),
      { wrapper: createWrapper(queryClient) },
    );
    await act(async () => {
      result.current.decisionMutation.mutate({ freeform: 'OK' });
    });
    await waitFor(() => expect(result.current.decisionMutation.error).not.toBe(null));
    expect(onClose).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    const cached = queryClient.getQueryData<BoardViewDto>(['board', 'merged', '', undefined]);
    expect(cached?.merged?.lanes['awaiting_human']).toHaveLength(1);
  });

  it('keeps the panel open when the answer resolved nothing (ambiguous gates)', async () => {
    postTicketDecisionMock.mockResolvedValue({
      kind: 'ticket',
      closed: false,
      ambiguousGateIds: ['g1', 'g2'],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    const notify = vi.fn();
    const { result } = renderHook(
      () => useTicketDecisionAnswer('bd-1', pendingDecision, { onClose, notify }),
      { wrapper: createWrapper(queryClient) },
    );
    await act(async () => {
      result.current.decisionMutation.mutate({ freeform: 'OK' });
    });
    await waitFor(() => expect(result.current.submittedDecision).not.toBe(null));
    expect(onClose).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
