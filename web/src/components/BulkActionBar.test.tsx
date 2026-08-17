import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BoardCardDto } from '../api';
import { BulkActionBar } from './BulkActionBar';
import {
  BulkSelectionProvider,
  useBulkSelection,
} from './BulkSelectionProvider';
import { UndoSnackbarProvider } from './UndoSnackbar';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    postTicketQuickAction: vi.fn(),
    postTicketQuickActionUndo: vi.fn(),
  };
});

import { postTicketQuickAction, postTicketQuickActionUndo } from '../api';

const mockPostTicketQuickAction = vi.mocked(postTicketQuickAction);
const mockPostTicketQuickActionUndo = vi.mocked(postTicketQuickActionUndo);

function makeCard(id: string, priority = 2): BoardCardDto {
  return {
    ticket: {
      id,
      projectId: 'proj-1',
      title: `Ticket ${id}`,
      status: 'open',
      priority,
      issueType: 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
    },
    lane: 'ready',
    projectId: 'proj-1',
    blockedBy: [],
    blocks: [],
    unblocksCount: 0,
    liveness: null,
    sessions: [],
    stalled: false,
    epicProgress: null,
    deferDays: null,
    deferUrgency: null,
    effectivePriority: priority,
    priorityInheritedFrom: null,
  };
}

function SelectionHarness({
  selectedIds,
  cardsById,
}: {
  selectedIds: string[];
  cardsById: Map<string, BoardCardDto>;
}) {
  const bulk = useBulkSelection();
  return (
    <>
      {selectedIds.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => bulk?.toggle(id)}
        >
          選択 {id}
        </button>
      ))}
      <BulkActionBar cardsById={cardsById} />
    </>
  );
}

function renderBulkBar(
  cardsById: Map<string, BoardCardDto>,
  selectedIds: string[] = [],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <UndoSnackbarProvider>
        <BulkSelectionProvider>
          <SelectionHarness selectedIds={selectedIds} cardsById={cardsById} />
        </BulkSelectionProvider>
      </UndoSnackbarProvider>
    </QueryClientProvider>,
  );

  for (const id of selectedIds) {
    fireEvent.click(screen.getByRole('button', { name: `選択 ${id}` }));
  }
}

describe('BulkActionBar', () => {
  beforeEach(() => {
    mockPostTicketQuickAction.mockReset();
    mockPostTicketQuickAction.mockResolvedValue(undefined);
    mockPostTicketQuickActionUndo.mockReset();
    mockPostTicketQuickActionUndo.mockResolvedValue(undefined);
  });

  it('shows selection count and runs bulk close with partial failure reporting', async () => {
    const cards = new Map([
      ['bdboard-ok', makeCard('bdboard-ok')],
      ['bdboard-fail', makeCard('bdboard-fail')],
    ]);

    mockPostTicketQuickAction.mockImplementation(async (id) => {
      if (id === 'bdboard-fail') {
        throw new Error('close failed');
      }
    });

    renderBulkBar(cards, ['bdboard-ok', 'bdboard-fail']);

    expect(screen.getByText('2件選択中')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '完了' }));
    fireEvent.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledTimes(2);
    });

    expect(screen.getByText('1件失敗: bdboard-fail')).toBeInTheDocument();
  });

  it('skips priority-up for cards at priority 0 while enabling the button when any card can raise', async () => {
    const cards = new Map([
      ['bdboard-p0', makeCard('bdboard-p0', 0)],
      ['bdboard-p2', makeCard('bdboard-p2', 2)],
    ]);

    renderBulkBar(cards, ['bdboard-p0', 'bdboard-p2']);

    const raiseButton = screen.getByRole('button', { name: '優先度を上げる' });
    expect(raiseButton).toBeEnabled();

    fireEvent.click(raiseButton);
    expect(
      screen.getByText(
        '選択中のうち優先度を上げられる 1 件の優先度を上げます。よろしいですか?',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledTimes(1);
    });
    expect(mockPostTicketQuickAction).toHaveBeenCalledWith('bdboard-p2', {
      action: 'priority',
      priority: 1,
    });
  });

  it('disables priority-up when every selected card is already at priority 0', () => {
    const cards = new Map([
      ['bdboard-p0a', makeCard('bdboard-p0a', 0)],
      ['bdboard-p0b', makeCard('bdboard-p0b', 0)],
    ]);

    renderBulkBar(cards, ['bdboard-p0a', 'bdboard-p0b']);

    expect(
      screen.getByRole('button', { name: '優先度を上げる' }),
    ).toBeDisabled();
  });

  it('skips priority-down for cards at priority 4 while enabling the button when any card can lower', async () => {
    const cards = new Map([
      ['bdboard-p4', makeCard('bdboard-p4', 4)],
      ['bdboard-p2', makeCard('bdboard-p2', 2)],
    ]);

    renderBulkBar(cards, ['bdboard-p4', 'bdboard-p2']);

    const lowerButton = screen.getByRole('button', { name: '優先度を下げる' });
    expect(lowerButton).toBeEnabled();

    fireEvent.click(lowerButton);
    expect(
      screen.getByText(
        '選択中のうち優先度を下げられる 1 件の優先度を下げます。よろしいですか?',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledTimes(1);
    });
    expect(mockPostTicketQuickAction).toHaveBeenCalledWith('bdboard-p2', {
      action: 'priority',
      priority: 3,
    });
  });

  it('disables priority-down when every selected card is already at priority 4', () => {
    const cards = new Map([
      ['bdboard-p4a', makeCard('bdboard-p4a', 4)],
      ['bdboard-p4b', makeCard('bdboard-p4b', 4)],
    ]);

    renderBulkBar(cards, ['bdboard-p4a', 'bdboard-p4b']);

    expect(
      screen.getByRole('button', { name: '優先度を下げる' }),
    ).toBeDisabled();
  });

  it('runs bulk defer for every selected card', async () => {
    const cards = new Map([
      ['bdboard-a', makeCard('bdboard-a')],
      ['bdboard-b', makeCard('bdboard-b')],
    ]);

    renderBulkBar(cards, ['bdboard-a', 'bdboard-b']);

    fireEvent.click(screen.getByRole('button', { name: '1週間延期' }));
    expect(
      screen.getByText(/選択中の 2 件を .+ まで延期します。よろしいですか?/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledTimes(2);
    });

    for (const id of ['bdboard-a', 'bdboard-b']) {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith(
        id,
        expect.objectContaining({
          action: 'defer',
          untilDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    }

    const deferCalls = mockPostTicketQuickAction.mock.calls.filter(
      ([, request]) => request.action === 'defer',
    );
    expect(deferCalls[0]?.[1]).toEqual(deferCalls[1]?.[1]);
  });

  it('reports undo partial failure when some undo requests fail', async () => {
    const cards = new Map([
      ['bdboard-ok', makeCard('bdboard-ok')],
      ['bdboard-undo-fail', makeCard('bdboard-undo-fail')],
    ]);

    mockPostTicketQuickActionUndo.mockImplementation(async (id) => {
      if (id === 'bdboard-undo-fail') {
        throw new Error('undo failed');
      }
    });

    renderBulkBar(cards, ['bdboard-ok', 'bdboard-undo-fail']);

    fireEvent.click(screen.getByRole('button', { name: '完了' }));
    fireEvent.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '元に戻す' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '元に戻す' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          '元に戻せませんでした: 1件中1件は元に戻せませんでした（対象: bdboard-undo-fail）',
        ),
      ).toBeInTheDocument();
    });

    expect(mockPostTicketQuickActionUndo).toHaveBeenCalledTimes(2);
  });
});
