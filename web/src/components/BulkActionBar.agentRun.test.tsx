import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCardDto, BoardViewDto, ProjectHarnessStatusDto } from '../api';
import { fetchAllHarnessStatus } from '../api';
import {
  cardsByIdOf,
  makeHarnessStatus,
  makeRunCard,
  makeSplitView,
} from '../test/bulkRunFixtures';
import { BulkActionBar } from './BulkActionBar';
import {
  BULK_RUN_HARNESS_CHECKING_REASON,
  BULK_RUN_LOOP_ACTIVE_REASON,
} from './bulk-action/agent-run/useBulkAgentRun';
import { BulkSelectionProvider, useBulkSelection } from './BulkSelectionProvider';
import {
  INITIAL_NEXT_UP_LOOP_PROGRESS,
  type NextUpLoopPhase,
  type NextUpRunLoopController,
} from './nextUpRunLoop';
import { UndoSnackbarProvider } from './UndoSnackbar';

// bdboard-mkm1.2: 一括操作バーの「▶ 実行」。実行ループのコントローラは偽物に差し替え、
// バーが「どの ID を・どの順で」渡すか、渡さない条件、渡した後の選択解除を直接見る。
// ループ本体の挙動 (1件ずつ・失敗しても次へ) は nextUpRunLoop.test.ts / NextUpView.test.tsx
// が押さえている。ハーネスの状態は GET /api/harness/status (fetchAllHarnessStatus) を差し替える。
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, fetchAllHarnessStatus: vi.fn() };
});

const fetchAllHarnessStatusMock = vi.mocked(fetchAllHarnessStatus);

function mockHarnessStatuses(statuses: ReadonlyMap<string, ProjectHarnessStatusDto>) {
  fetchAllHarnessStatusMock.mockResolvedValue({
    projects: [...statuses].map(([projectId, status]) => ({ projectId, ...status })),
  });
}

function makeController(phase: NextUpLoopPhase = 'idle'): NextUpRunLoopController {
  return {
    phase,
    progress: INITIAL_NEXT_UP_LOOP_PROGRESS,
    beginBatchRun: vi.fn(),
    stopBatchRun: vi.fn(),
  };
}

interface HarnessProps {
  cards: readonly BoardCardDto[];
  board: BoardViewDto | undefined;
  batchRun: NextUpRunLoopController;
  withAgentRun?: boolean;
}

function Harness({ cards, board, batchRun, withAgentRun = true }: HarnessProps) {
  const bulk = useBulkSelection();
  return (
    <>
      {cards.map((card) => (
        <button key={card.ticket.id} type="button" onClick={() => bulk?.toggle(card.ticket.id)}>
          選択 {card.ticket.id}
        </button>
      ))}
      <span data-testid="selected">{[...(bulk?.selectedIds ?? [])].join(',')}</span>
      <BulkActionBar
        cardsById={cardsByIdOf(cards)}
        agentRun={
          withAgentRun
            ? {
                batchRun,
                board,
                projectNames: new Map([
                  ['proj-1', 'Project One'],
                  ['proj-2', 'Project Two'],
                ]),
              }
            : undefined
        }
      />
    </>
  );
}

async function renderBar(
  props: HarnessProps,
  selectIds: readonly string[],
  { waitForHarness = true }: { waitForHarness?: boolean } = {},
) {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = (batchRun: NextUpRunLoopController) => (
    <QueryClientProvider client={queryClient}>
      <UndoSnackbarProvider>
        <BulkSelectionProvider>
          <Harness {...props} batchRun={batchRun} />
        </BulkSelectionProvider>
      </UndoSnackbarProvider>
    </QueryClientProvider>
  );
  const utils = render(ui(props.batchRun));
  const rerenderWith = (batchRun: NextUpRunLoopController) => utils.rerender(ui(batchRun));
  for (const id of selectIds) {
    await user.click(screen.getByRole('button', { name: `選択 ${id}` }));
  }
  if (waitForHarness && props.withAgentRun !== false && selectIds.length > 0) {
    await waitFor(() => {
      expect(screen.queryByText(BULK_RUN_HARNESS_CHECKING_REASON)).not.toBeInTheDocument();
    });
  }
  return { user, queryClient, rerenderWith, ...utils };
}

const runButton = () => screen.getByRole('button', { name: '▶ 実行' });
const confirmDialog = () => screen.getByRole('alertdialog', { name: 'エージェント実行の確認' });

describe('BulkActionBar ▶ 実行 (bdboard-mkm1.2)', () => {
  beforeEach(() => {
    fetchAllHarnessStatusMock.mockReset();
    fetchAllHarnessStatusMock.mockResolvedValue({ projects: [] });
  });

  it('does not show the run button when no agentRun config is passed', async () => {
    const cards = [makeRunCard('t-1')];
    await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun: makeController(), withAgentRun: false },
      ['t-1'],
    );

    expect(screen.getByText('1件選択中')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '▶ 実行' })).not.toBeInTheDocument();
    expect(fetchAllHarnessStatusMock).not.toHaveBeenCalled();
  });

  it('checks the harness status only once something is selected', async () => {
    const cards = [makeRunCard('t-1')];
    const { user } = await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun: makeController() },
      [],
    );
    expect(fetchAllHarnessStatusMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '選択 t-1' }));
    await waitFor(() => {
      expect(fetchAllHarnessStatusMock).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps ▶ 実行 disabled while the harness status is being checked', async () => {
    fetchAllHarnessStatusMock.mockReturnValue(new Promise(() => {}));
    const cards = [makeRunCard('t-1')];
    await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun: makeController() },
      ['t-1'],
      { waitForHarness: false },
    );

    expect(runButton()).toBeDisabled();
    expect(runButton()).toHaveAttribute('title', BULK_RUN_HARNESS_CHECKING_REASON);
  });

  it('does not block when the harness status cannot be fetched (the server preflight decides)', async () => {
    fetchAllHarnessStatusMock.mockRejectedValue(new Error('boom'));
    const cards = [makeRunCard('t-1')];
    await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun: makeController() },
      ['t-1'],
    );

    expect(runButton()).toBeEnabled();
  });

  it('runs the selected cards in display (priority) order and clears the selection', async () => {
    const p2High = makeRunCard('p2-high', { projectId: 'proj-2', priority: 1 });
    const p1High = makeRunCard('p1-high', { projectId: 'proj-1', priority: 1 });
    const p1Low = makeRunCard('p1-low', { projectId: 'proj-1', priority: 3 });
    const p2Mid = makeRunCard('p2-mid', { projectId: 'proj-2', priority: 2 });
    const cards = [p1Low, p2Mid, p1High, p2High];
    const board = makeSplitView([
      { id: 'proj-2', cards: [p2High, p2Mid] },
      { id: 'proj-1', cards: [p1High, p1Low] },
    ]);
    const batchRun = makeController();
    const { user } = await renderBar({ cards, board, batchRun }, [
      'p1-low',
      'p2-mid',
      'p1-high',
      'p2-high',
    ]);

    await user.click(runButton());
    const dialog = confirmDialog();
    expect(dialog).toHaveTextContent('選択中の 4 件を、優先度の高い順');
    expect(
      within(within(dialog).getByRole('list', { name: '実行順' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'p2-high Ticket p2-high',
      'p1-high Ticket p1-high',
      'p2-mid Ticket p2-mid',
      'p1-low Ticket p1-low',
    ]);

    await user.click(within(dialog).getByRole('button', { name: '実行する' }));

    expect(batchRun.beginBatchRun).toHaveBeenCalledTimes(1);
    expect(batchRun.beginBatchRun).toHaveBeenCalledWith(['p2-high', 'p1-high', 'p2-mid', 'p1-low']);
    expect(screen.getByTestId('selected')).toHaveTextContent('');
    expect(screen.queryByText(/件選択中/)).not.toBeInTheDocument();
  });

  it('shows the excluded count and reasons, and passes only the eligible cards', async () => {
    const cards = [
      makeRunCard('ok-2', { priority: 2 }),
      makeRunCard('ok-1', { priority: 1 }),
      makeRunCard('epic', { issueType: 'epic' }),
      makeRunCard('blocked', { lane: 'blocked' }),
      makeRunCard('doing', { lane: 'in_progress' }),
    ];
    const board = makeSplitView([{ id: 'proj-1', cards }]);
    const batchRun = makeController();
    const { user } = await renderBar({ cards, board, batchRun }, [
      'ok-2',
      'epic',
      'blocked',
      'doing',
      'ok-1',
    ]);

    await user.click(runButton());
    const dialog = confirmDialog();
    expect(dialog).toHaveTextContent('選択中の 2 件を');
    expect(dialog).toHaveTextContent(
      '対象外 3 件: epic 1 件・ブロック中 1 件・着手可能レーン以外 1 件',
    );

    await user.click(within(dialog).getByRole('button', { name: '実行する' }));
    expect(batchRun.beginBatchRun).toHaveBeenCalledWith(['ok-1', 'ok-2']);
  });

  it('keeps 実行する disabled when every selected card is excluded', async () => {
    const cards = [makeRunCard('epic', { issueType: 'epic' }), makeRunCard('b', { lane: 'blocked' })];
    const batchRun = makeController();
    const { user } = await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun },
      ['epic', 'b'],
    );

    await user.click(runButton());
    const dialog = confirmDialog();
    expect(dialog).toHaveTextContent('実行できるカードがありません');
    expect(dialog).toHaveTextContent('対象外 2 件: epic 1 件・ブロック中 1 件');
    const confirm = within(dialog).getByRole('button', { name: '実行する' });
    expect(confirm).toBeDisabled();

    await user.click(confirm);
    expect(batchRun.beginBatchRun).not.toHaveBeenCalled();
  });

  it('cancels without running and keeps the selection', async () => {
    const cards = [makeRunCard('t-1')];
    const batchRun = makeController();
    const { user } = await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun },
      ['t-1'],
    );

    await user.click(runButton());
    await user.click(within(confirmDialog()).getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(batchRun.beginBatchRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('selected')).toHaveTextContent('t-1');
  });

  it('closes the dialog on Escape and moves the initial focus to キャンセル', async () => {
    const cards = [makeRunCard('t-1')];
    const { user } = await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun: makeController() },
      ['t-1'],
    );

    await user.click(runButton());
    expect(within(confirmDialog()).getByRole('button', { name: 'キャンセル' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('disables the other bulk actions while the run confirmation is open', async () => {
    const cards = [makeRunCard('t-1', { priority: 2 })];
    const { user } = await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun: makeController() },
      ['t-1'],
    );

    expect(screen.getByRole('button', { name: '完了' })).toBeEnabled();
    await user.click(runButton());

    expect(screen.getByRole('button', { name: '完了' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '優先度を上げる' })).toBeDisabled();
    expect(runButton()).toBeDisabled();
  });

  it('disables ▶ 実行 while another bulk action is being confirmed', async () => {
    const cards = [makeRunCard('t-1')];
    const { user } = await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun: makeController() },
      ['t-1'],
    );

    await user.click(screen.getByRole('button', { name: '完了' }));
    expect(runButton()).toBeDisabled();
  });

  it('closes the confirmation when the selection changes, so a stale selection never runs', async () => {
    const cards = [makeRunCard('t-1'), makeRunCard('t-2')];
    const batchRun = makeController();
    const { user } = await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun },
      ['t-1'],
    );

    await user.click(runButton());
    expect(confirmDialog()).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '選択 t-2' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(batchRun.beginBatchRun).not.toHaveBeenCalled();
  });

  it('does not reopen the dialog by itself after a batch started elsewhere finishes', async () => {
    const cards = [makeRunCard('t-1')];
    const idle = makeController();
    const { user, rerenderWith } = await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun: idle },
      ['t-1'],
    );
    await user.click(runButton());
    expect(confirmDialog()).toBeInTheDocument();

    // 確認を開いたまま、別の入口からループが始まって終わる (progress は毎回差し替わる)。
    rerenderWith({ ...makeController('running'), progress: { ...idle.progress, totalCount: 2 } });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    rerenderWith({ ...makeController('idle'), progress: { ...idle.progress, totalCount: 2 } });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('selected')).toHaveTextContent('t-1');
  });

  it('disables 実行する when a harness gap shows up while the dialog is open', async () => {
    const cards = [makeRunCard('t-1')];
    const batchRun = makeController();
    const { user, queryClient } = await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun },
      ['t-1'],
    );
    await user.click(runButton());
    const confirm = within(confirmDialog()).getByRole('button', { name: '実行する' });
    expect(confirm).toBeEnabled();

    act(() => {
      queryClient.setQueryData(['harness-status-all'], {
        projects: [{ projectId: 'proj-1', ...makeHarnessStatus(false) }],
      });
    });

    // react-query は購読者への通知を次のタスクへ遅らせるので待つ。
    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
    expect(confirmDialog()).toHaveTextContent('Project One: ハーネス未注入 — Hygiene から注入');
    await user.click(confirm);
    expect(batchRun.beginBatchRun).not.toHaveBeenCalled();
  });

  it('refuses to run when a run target project misses the harness prerequisites, naming the project', async () => {
    const cards = [
      makeRunCard('ok', { projectId: 'proj-1' }),
      makeRunCard('bad', { projectId: 'proj-2' }),
    ];
    mockHarnessStatuses(
      new Map([
        ['proj-1', makeHarnessStatus(true)],
        ['proj-2', makeHarnessStatus(false)],
      ]),
    );
    const batchRun = makeController();
    const { user } = await renderBar(
      {
        cards,
        board: makeSplitView([
          { id: 'proj-1', cards: [cards[0]] },
          { id: 'proj-2', cards: [cards[1]] },
        ]),
        batchRun,
      },
      ['ok', 'bad'],
    );

    const reason = 'Project Two: ハーネス未注入 — Hygiene から注入';
    await waitFor(() => {
      expect(runButton()).toBeDisabled();
    });
    expect(runButton()).toHaveAttribute('title', reason);
    expect(screen.getByText(reason)).toBeInTheDocument();

    await user.click(runButton());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(batchRun.beginBatchRun).not.toHaveBeenCalled();
  });

  it('does not block on a harness gap of a project that only has excluded cards', async () => {
    const cards = [
      makeRunCard('ok', { projectId: 'proj-1' }),
      makeRunCard('epic', { projectId: 'proj-2', issueType: 'epic' }),
    ];
    mockHarnessStatuses(
      new Map([
        ['proj-1', makeHarnessStatus(true)],
        ['proj-2', makeHarnessStatus(false)],
      ]),
    );
    await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun: makeController() },
      ['ok', 'epic'],
    );

    expect(runButton()).toBeEnabled();
  });

  it('disables ▶ 実行 while a batch is already running and points to the header chip', async () => {
    const cards = [makeRunCard('t-1')];
    const batchRun = makeController('running');
    const { user } = await renderBar(
      { cards, board: makeSplitView([{ id: 'proj-1', cards }]), batchRun },
      ['t-1'],
    );

    expect(runButton()).toBeDisabled();
    expect(screen.getByText(BULK_RUN_LOOP_ACTIVE_REASON)).toBeInTheDocument();
    await user.click(runButton());
    expect(batchRun.beginBatchRun).not.toHaveBeenCalled();
  });
});
