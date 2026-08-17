import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DragEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postTicketQuickAction, postTicketQuickActionUndo, type Lane } from '../api';
import {
  BOARD_CARD_DRAG_MIME,
  BoardDnDProvider,
  useBoardDnD,
} from './BoardDnDProvider';
import { UndoSnackbarProvider } from './UndoSnackbar';

// このテストは実際のHTML5ドラッグ&ドロップをjsdom上で再現するのではなく、
// useBoardDnD() が公開するコンテキストAPI(onLaneDrop)を直接呼ぶことで、
// クイックアクション実行成功→Undoスナックバー表示→Undo押下→逆操作APIの呼び出し、
// という配線を検証する(BoardDnDProviderにはこれまでテストが無かった)。
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    postTicketQuickAction: vi.fn(),
    postTicketQuickActionUndo: vi.fn(),
  };
});

const mockPostTicketQuickAction = vi.mocked(postTicketQuickAction);
const mockPostTicketQuickActionUndo = vi.mocked(postTicketQuickActionUndo);

function makeFakeDropEvent(
  ticketId: string,
  sourceLane: Lane,
): DragEvent<HTMLElement> {
  const payload = JSON.stringify({ ticketId, sourceLane });
  return {
    preventDefault: () => {},
    dataTransfer: {
      getData: (kind: string) =>
        kind === BOARD_CARD_DRAG_MIME || kind === 'text/plain' ? payload : '',
    },
  } as unknown as DragEvent<HTMLElement>;
}

function DropHarness({
  ticketId,
  sourceLane,
  targetLane,
}: {
  ticketId: string;
  sourceLane: Lane;
  targetLane: Lane;
}) {
  const dnd = useBoardDnD();
  if (dnd === null) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() =>
        dnd.onLaneDrop(targetLane, makeFakeDropEvent(ticketId, sourceLane))
      }
    >
      drop
    </button>
  );
}

function renderHarness(
  ticketId: string,
  sourceLane: Lane,
  targetLane: Lane,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <UndoSnackbarProvider>
      <QueryClientProvider client={queryClient}>
        <BoardDnDProvider>
          <DropHarness
            ticketId={ticketId}
            sourceLane={sourceLane}
            targetLane={targetLane}
          />
        </BoardDnDProvider>
      </QueryClientProvider>
    </UndoSnackbarProvider>,
  );
}

describe('BoardDnDProvider quick action undo snackbar', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    mockPostTicketQuickAction.mockResolvedValue(undefined);
    mockPostTicketQuickActionUndo.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an undo snackbar after a DnD claim and posts unclaim-equivalent undo on click', async () => {
    renderHarness('bdboard-x', 'ready', 'in_progress');

    await user.click(screen.getByRole('button', { name: 'drop' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith('bdboard-x', {
        action: 'claim',
      });
    });

    expect(await screen.findByText('着手しました')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '元に戻す' }));

    await waitFor(() => {
      expect(mockPostTicketQuickActionUndo).toHaveBeenCalledWith('bdboard-x', {
        action: 'claim',
      });
    });
  });

  it('shows an undo snackbar after a DnD close and posts reopen-equivalent undo on click', async () => {
    renderHarness('bdboard-y', 'in_progress', 'done');

    await user.click(screen.getByRole('button', { name: 'drop' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith('bdboard-y', {
        action: 'close',
      });
    });

    expect(await screen.findByText('完了にしました')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '元に戻す' }));

    await waitFor(() => {
      expect(mockPostTicketQuickActionUndo).toHaveBeenCalledWith('bdboard-y', {
        action: 'close',
      });
    });
  });

  it('does not show an undo snackbar when the drop is rejected (no quick action ran)', async () => {
    // done -> done は resolveDropAction 上 reject。クイックアクションが走っていない
    // ケースでスナックバーが出ないことを保証する(=配線が「常に出す」実装に壊れて
    // いないかのガード)。
    renderHarness('bdboard-z', 'done', 'done');

    await user.click(screen.getByRole('button', { name: 'drop' }));

    expect(mockPostTicketQuickAction).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '元に戻す' })).not.toBeInTheDocument();
  });
});
