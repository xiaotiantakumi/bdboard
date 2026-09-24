// bdboard-mkm1.2: 一括操作バーから始めた実行が、ビューを切り替えても (バーとボードが
// アンマウントされても) 進み続け、ヘッダーのチップに進捗が出続けることを、本物の
// 実行ループ (useNextUpRunLoopController) で確かめる。API 呼び出しだけを差し替える。
// App 側の配線 (ヘッダーとバーが同じ nextUpBatchRun を受け取ること) は
// AppBody.wiring.test.tsx / AppBoardViewSwitch.test.tsx が押さえている。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunDetailDto } from '../../api';
import { fetchAgentRun, postTicketComment, startTicketRun } from '../../api';
import { cardsByIdOf, makeRunCard, makeSplitView } from '../../test/bulkRunFixtures';
import { AGENT_RUN_POLL_INTERVAL_MS } from '../agentRunShared';
import { BulkActionBar } from '../BulkActionBar';
import { BulkSelectionProvider, useBulkSelection } from '../BulkSelectionProvider';
import { useNextUpRunLoopController } from '../nextUpRunLoop';
import { UndoSnackbarProvider } from '../UndoSnackbar';
import { BatchRunProgressChip } from './BatchRunProgressChip';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    startTicketRun: vi.fn(),
    fetchAgentRun: vi.fn(),
    postTicketComment: vi.fn(),
    fetchAllHarnessStatus: vi.fn(() => Promise.resolve({ projects: [] })),
  };
});

const mockStartTicketRun = vi.mocked(startTicketRun);
const mockFetchAgentRun = vi.mocked(fetchAgentRun);
const mockPostTicketComment = vi.mocked(postTicketComment);

const cards = [makeRunCard('t-1', { priority: 1 }), makeRunCard('t-2', { priority: 2 })];
const board = makeSplitView([{ id: 'proj-1', cards }]);

function BoardView({ batchRun }: { batchRun: ReturnType<typeof useNextUpRunLoopController> }) {
  const bulk = useBulkSelection();
  return (
    <section aria-label="ボード">
      {cards.map((card) => (
        <button key={card.ticket.id} type="button" onClick={() => bulk?.toggle(card.ticket.id)}>
          選択 {card.ticket.id}
        </button>
      ))}
      <BulkActionBar
        cardsById={cardsByIdOf(cards)}
        agentRun={{ batchRun, board, projectNames: new Map([['proj-1', 'Project One']]) }}
      />
    </section>
  );
}

// App と同じ持ち方: 実行ループはビューより上 (App) が持ち、ヘッダーのチップと
// 一括操作バーの両方へ同じコントローラを渡す。ビューだけが切り替わる。
function MiniApp() {
  const batchRun = useNextUpRunLoopController();
  const [view, setView] = useState<'board' | 'stats'>('board');
  return (
    <>
      <header>
        <BatchRunProgressChip batchRun={batchRun} />
        <button type="button" onClick={() => setView(view === 'board' ? 'stats' : 'board')}>
          ビュー切替
        </button>
      </header>
      {view === 'board' ? <BoardView batchRun={batchRun} /> : <section aria-label="統計" />}
    </>
  );
}

function runDetail(ticketId: string, status: AgentRunDetailDto['status']): AgentRunDetailDto {
  return {
    id: `run-${ticketId}`,
    ticketId,
    runner: 'claude',
    mode: 'spawn',
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    cwd: `/tmp/worktrees/${ticketId}`,
    log: '',
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('bulk ▶ 実行 progress across view switches (bdboard-mkm1.2)', () => {
  const statusByTicket = new Map<string, AgentRunDetailDto['status']>();

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    statusByTicket.clear();
    mockPostTicketComment.mockResolvedValue(undefined);
    mockStartTicketRun.mockImplementation((ticketId) =>
      Promise.resolve({
        runId: `run-${ticketId}`,
        ticketId,
        status: 'pending',
        worktreePath: `/tmp/worktrees/${ticketId}`,
        branchName: `bd/${ticketId}`,
        reused: false,
      }),
    );
    mockFetchAgentRun.mockImplementation((runId) => {
      const ticketId = runId.replace(/^run-/, '');
      return Promise.resolve(runDetail(ticketId, statusByTicket.get(ticketId) ?? 'running'));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('keeps running and reporting progress after the board view is unmounted', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <UndoSnackbarProvider>
          <BulkSelectionProvider>
            <MiniApp />
          </BulkSelectionProvider>
        </UndoSnackbarProvider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: '選択 t-2' }));
    await user.click(screen.getByRole('button', { name: '選択 t-1' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '▶ 実行' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: '▶ 実行' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: '実行する' }),
    );

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledWith('t-1');
    });
    expect(screen.getByRole('status')).toHaveTextContent('現在: t-1 | 完了 0/2');

    // ビューを切り替える — 一括操作バーもボードもアンマウントされる。
    await user.click(screen.getByRole('button', { name: 'ビュー切替' }));
    expect(screen.queryByRole('region', { name: 'ボード' })).not.toBeInTheDocument();

    statusByTicket.set('t-1', 'succeeded');
    await advance(AGENT_RUN_POLL_INTERVAL_MS);
    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenNthCalledWith(2, 't-2');
    });
    expect(screen.getByRole('status')).toHaveTextContent('現在: t-2 | 完了 1/2');

    statusByTicket.set('t-2', 'succeeded');
    await advance(AGENT_RUN_POLL_INTERVAL_MS);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('前回の実行: 完走 | 完了 2/2');
    });
    expect(mockStartTicketRun).toHaveBeenCalledTimes(2);
  });

  it('can be stopped from the header chip while another view is shown', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <UndoSnackbarProvider>
          <BulkSelectionProvider>
            <MiniApp />
          </BulkSelectionProvider>
        </UndoSnackbarProvider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: '選択 t-1' }));
    await user.click(screen.getByRole('button', { name: '選択 t-2' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '▶ 実行' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: '▶ 実行' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: '実行する' }),
    );
    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledWith('t-1');
    });

    await user.click(screen.getByRole('button', { name: 'ビュー切替' }));
    await user.click(screen.getByRole('button', { name: '■ 停止' }));
    await advance(AGENT_RUN_POLL_INTERVAL_MS);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('前回の実行: 中断');
    });
    expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
    expect(mockStartTicketRun).not.toHaveBeenCalledWith('t-2');
  });
});
