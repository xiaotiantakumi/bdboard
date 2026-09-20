import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postTicketDecision, type PendingDecisionDto } from '../../api';
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
      result.current.decisionMutation.mutate();
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
      result.current.decisionMutation.mutate();
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
});
