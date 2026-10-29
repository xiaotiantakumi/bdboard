import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCardDto } from '../api';
import { BulkActionBar } from './BulkActionBar';
import { BulkSelectionProvider, useBulkSelection } from './BulkSelectionProvider';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, postTicketDecision: vi.fn(), postTicketComment: vi.fn() };
});

import { postTicketComment, postTicketDecision } from '../api';

const mockDecision = vi.mocked(postTicketDecision);
const mockComment = vi.mocked(postTicketComment);

function card(id: string): BoardCardDto {
  return { ticket: { id } } as unknown as BoardCardDto;
}

function Harness({ ids, pending }: { ids: string[]; pending: string[] }) {
  const bulk = useBulkSelection();
  const cardsById = new Map(ids.map((id) => [id, card(id)]));
  return (
    <>
      {ids.map((id) => (
        <button key={id} type="button" onClick={() => bulk?.toggle(id)}>
          選択 {id}
        </button>
      ))}
      <BulkActionBar cardsById={cardsById} pendingDecisionIds={new Set(pending)} />
    </>
  );
}

function setup() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BulkSelectionProvider>
        <Harness ids={['a', 'b']} pending={['a']} />
      </BulkSelectionProvider>
    </QueryClientProvider>,
  );
}

describe('BulkActionBar', () => {
  beforeEach(() => {
    mockDecision.mockReset();
    mockComment.mockReset();
    mockDecision.mockResolvedValue({ kind: 'ticket', closed: false });
    mockComment.mockResolvedValue(undefined);
  });

  it('OK answers pending tickets and comments on the others', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('選択 a'));
    await user.click(screen.getByText('選択 b'));
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.getByText('2件成功')).toBeInTheDocument());
    expect(mockDecision).toHaveBeenCalledWith('a', { freeform: 'OK' });
    expect(mockComment).toHaveBeenCalledWith('b', 'OK');
  });

  it('reports failures and sends a bulk comment', async () => {
    const user = userEvent.setup();
    mockComment.mockRejectedValueOnce(new Error('boom'));
    setup();
    await user.click(screen.getByText('選択 b'));
    await user.type(screen.getByLabelText('一括コメント'), 'hello');
    await user.click(screen.getByRole('button', { name: 'コメント送信' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('1件失敗: b'));
    expect(mockComment).toHaveBeenCalledWith('b', 'hello');
  });
});
