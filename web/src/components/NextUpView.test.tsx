import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRunDetailDto,
  BoardCardDto,
  BoardDto,
  ProjectHarnessContractDto,
  ProjectHarnessStatusDto,
} from '../api';
import { ApiError, fetchAgentRun, postTicketComment, startTicketRun } from '../api';
import { AGENT_RUN_POLL_INTERVAL_MS } from './agentRunShared';
import { NextUpView, type NextUpViewProps } from './NextUpView';
import {
  NEXT_UP_LOOP_POLL_MAX_DELAY_MS,
  NEXT_UP_LOOP_POLL_MAX_FAILURES,
  useNextUpRunLoopController,
} from './nextUpRunLoop';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    startTicketRun: vi.fn(),
    fetchAgentRun: vi.fn(),
    postTicketComment: vi.fn(),
  };
});

const mockStartTicketRun = vi.mocked(startTicketRun);
const mockFetchAgentRun = vi.mocked(fetchAgentRun);
const mockPostTicketComment = vi.mocked(postTicketComment);

function renderWithWatch(ui: ReactElement) {
  return render(<WatchedTicketsProvider>{ui}</WatchedTicketsProvider>);
}

function makeCard(
  id: string,
  title: string,
  projectId = 'proj-1',
  options?: { issueType?: BoardCardDto['ticket']['issueType']; priority?: number },
): BoardCardDto {
  const priority = options?.priority ?? 2;
  const issueType = options?.issueType ?? 'task';
  return {
    ticket: {
      id,
      projectId,
      title,
      status: 'open',
      priority,
      issueType,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
    },
    lane: 'ready',
    projectId,
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

function makeBoard(readyCards: BoardCardDto[]): BoardDto {
  return {
    lanes: {
      ready: readyCards,
      in_progress: [],
      blocked: [],
      done: [],
    },
    cardCount: readyCards.length,
    closedTotal: 0,
    truncatedClosedIds: [],
  };
}

const projectNames = new Map([['proj-1', 'Project One']]);
const projectActiveSessions = new Map([['proj-1', 0]]);

type OwnedNextUpViewProps = Omit<NextUpViewProps, 'batchRun'>;

function NextUpViewWithRunOwner(props: OwnedNextUpViewProps) {
  const batchRun = useNextUpRunLoopController();
  return <NextUpView {...props} batchRun={batchRun} />;
}

function ViewSwitchHarness(props: OwnedNextUpViewProps) {
  const [showNextUp, setShowNextUp] = useState(true);
  const batchRun = useNextUpRunLoopController();

  return (
    <>
      <button type="button" onClick={() => setShowNextUp((visible) => !visible)}>
        {showNextUp ? 'Kanban へ' : 'Next Up へ'}
      </button>
      {showNextUp && <NextUpView {...props} batchRun={batchRun} />}
    </>
  );
}

const OK_HARNESS_CONTRACT: ProjectHarnessContractDto = {
  state: 'ok',
  verify: 'npm run verify',
  prFlow: 'pr',
  mainBranch: 'main',
};

/** エージェント実行の前提を満たしたハーネス状態 (bdboard-pkr6.11)。 */
function harnessStatus(
  contract: ProjectHarnessContractDto = OK_HARNESS_CONTRACT,
  installedVersion: string | null = '1.0.0',
): ProjectHarnessStatusDto {
  return {
    packs: [
      {
        name: 'bdboard-harness',
        availableVersion: '1.0.0',
        installedVersion,
        drift: false,
        hooksState: 'ok',
        missingHooks: [],
      },
    ],
    contract,
  };
}

function renderNextUpView(
  board: BoardDto,
  options?: {
    limit?: 5 | 10 | 20;
    onLimitChange?: (limit: 5 | 10 | 20) => void;
    showEpics?: boolean;
    onShowEpicsChange?: (show: boolean) => void;
    harnessStatuses?: ReadonlyMap<string, ProjectHarnessStatusDto>;
  },
) {
  const onLimitChange = options?.onLimitChange ?? vi.fn();
  const onShowEpicsChange = options?.onShowEpicsChange ?? vi.fn();
  renderWithWatch(
    <NextUpViewWithRunOwner
      board={board}
      limit={options?.limit ?? 10}
      onLimitChange={onLimitChange}
      showEpics={options?.showEpics ?? false}
      onShowEpicsChange={onShowEpicsChange}
      projectNames={projectNames}
      projectActiveSessions={projectActiveSessions}
      pendingDecisionIds={new Set()}
      prLinksById={new Map()}
      onCardClick={() => {}}
      harnessStatuses={options?.harnessStatuses}
    />,
  );
  return { onLimitChange, onShowEpicsChange };
}

function makeRunDetail(
  runId: string,
  ticketId: string,
  status: AgentRunDetailDto['status'],
): AgentRunDetailDto {
  return {
    id: runId,
    ticketId,
    runner: 'claude',
    mode: 'spawn',
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    cwd: `/tmp/worktrees/${ticketId}`,
    log: '',
  };
}

async function openBatchRunConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '▶ 一括実行' }));
}

async function confirmBatchRun(user: ReturnType<typeof userEvent.setup>) {
  const dialog = screen.getByRole('alertdialog', { name: '一括実行の確認' });
  await user.click(within(dialog).getByRole('button', { name: '実行する' }));
}

async function startBatchRun(user: ReturnType<typeof userEvent.setup>) {
  await openBatchRunConfirm(user);
  await confirmBatchRun(user);
}

describe('NextUpView', () => {
  it('shows the first N ready cards in server order', () => {
    // サーバー(mergeBoards)が返した順序をフロントで並べ替えないことを保証する。
    // 意図的にタイトル/IDの辞書順とは一致しない順序で渡している。
    const serverOrder = [
      'Task 7',
      'Task 3',
      'Task 11',
      'Task 1',
      'Task 9',
      'Task 2',
      'Task 5',
    ];
    const cards = serverOrder.map((title, index) => makeCard(`ticket-${index + 1}`, title));
    renderNextUpView(makeBoard(cards), { limit: 5 });

    const renderedTitles = screen
      .getAllByRole('button', { name: /Task/ })
      .map((element) => element.querySelector('.card-title')?.textContent);
    expect(renderedTitles).toEqual(serverOrder.slice(0, 5));
    expect(screen.queryByText('Task 2')).not.toBeInTheDocument();
    expect(screen.queryByText('Task 5')).not.toBeInTheDocument();
  });

  it('excludes epics from the main list while preserving server order among regular tickets', () => {
    const cards = [
      makeCard('epic-1', 'Epic Alpha', 'proj-1', { issueType: 'epic', priority: 0 }),
      makeCard('task-1', 'Task One', 'proj-1', { issueType: 'task', priority: 1 }),
      makeCard('epic-2', 'Epic Beta', 'proj-1', { issueType: 'epic', priority: 0 }),
      makeCard('task-2', 'Task Two', 'proj-1', { issueType: 'task', priority: 2 }),
      makeCard('task-3', 'Task Three', 'proj-1', { issueType: 'task', priority: 3 }),
    ];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    const renderedTitles = screen
      .getAllByRole('button', { name: /Task/ })
      .map((element) => element.querySelector('.card-title')?.textContent);
    expect(renderedTitles).toEqual(['Task One', 'Task Two', 'Task Three']);
    expect(screen.queryByText('Epic Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('Epic Beta')).not.toBeInTheDocument();
  });

  it('does not render the epic section when showEpics is false', () => {
    const cards = [
      makeCard('epic-1', 'Epic Alpha', 'proj-1', { issueType: 'epic', priority: 0 }),
      makeCard('task-1', 'Task One', 'proj-1'),
    ];
    renderNextUpView(makeBoard(cards), { showEpics: false });

    expect(screen.queryByRole('heading', { name: 'Epic' })).not.toBeInTheDocument();
    expect(screen.queryByText('Epic Alpha')).not.toBeInTheDocument();
  });

  it('renders the epic section when showEpics is true', () => {
    const cards = [
      makeCard('epic-1', 'Epic Alpha', 'proj-1', { issueType: 'epic', priority: 0 }),
      makeCard('task-1', 'Task One', 'proj-1'),
      makeCard('epic-2', 'Epic Beta', 'proj-1', { issueType: 'epic', priority: 0 }),
    ];
    renderNextUpView(makeBoard(cards), { showEpics: true, limit: 5 });

    expect(screen.getByRole('heading', { name: 'Epic' })).toBeInTheDocument();
    expect(screen.getByText('Epic Alpha')).toBeInTheDocument();
    expect(screen.getByText('Epic Beta')).toBeInTheDocument();
  });

  it('calls onLimitChange when a limit button is clicked', async () => {
    const user = userEvent.setup();
    const cards = Array.from({ length: 12 }, (_, index) =>
      makeCard(`ticket-${index + 1}`, `Task ${index + 1}`),
    );
    const { onLimitChange } = renderNextUpView(makeBoard(cards), { limit: 10 });

    await user.click(screen.getByRole('button', { name: '20' }));

    expect(onLimitChange).toHaveBeenCalledWith(20);
  });

  it('calls onShowEpicsChange when the epic toggle is clicked', async () => {
    const user = userEvent.setup();
    const cards = [
      makeCard('epic-1', 'Epic Alpha', 'proj-1', { issueType: 'epic', priority: 0 }),
      makeCard('task-1', 'Task One', 'proj-1'),
    ];
    const { onShowEpicsChange } = renderNextUpView(makeBoard(cards), { showEpics: false });

    await user.click(screen.getByRole('button', { name: 'epic を表示 (1)' }));

    expect(onShowEpicsChange).toHaveBeenCalledWith(true);
  });

  it('changes displayed count when the limit changes', () => {
    const cards = Array.from({ length: 12 }, (_, index) =>
      makeCard(`ticket-${index + 1}`, `Task ${index + 1}`),
    );
    const board = makeBoard(cards);
    const onLimitChange = vi.fn();
    const onShowEpicsChange = vi.fn();

    const { rerender } = renderWithWatch(
      <NextUpViewWithRunOwner
        board={board}
        limit={5}
        onLimitChange={onLimitChange}
        showEpics={false}
        onShowEpicsChange={onShowEpicsChange}
        projectNames={projectNames}
        projectActiveSessions={projectActiveSessions}
        pendingDecisionIds={new Set()}
        prLinksById={new Map()}
        onCardClick={() => {}}
      />,
    );

    expect(screen.getByText('Task 5')).toBeInTheDocument();
    expect(screen.queryByText('Task 6')).not.toBeInTheDocument();

    rerender(
      <WatchedTicketsProvider>
        <NextUpViewWithRunOwner
          board={board}
          limit={10}
          onLimitChange={onLimitChange}
          showEpics={false}
          onShowEpicsChange={onShowEpicsChange}
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={new Set()}
          prLinksById={new Map()}
          onCardClick={() => {}}
        />
      </WatchedTicketsProvider>,
    );

    expect(screen.getByText('Task 10')).toBeInTheDocument();
    expect(screen.queryByText('Task 11')).not.toBeInTheDocument();
  });

  it('shows an empty state when ready has no cards', () => {
    renderNextUpView(makeBoard([]));

    expect(screen.getByText('着手できるチケットはありません')).toBeInTheDocument();
  });

  it('marks the selected display limit with aria-pressed', () => {
    renderNextUpView(makeBoard([]), { limit: 5 });

    expect(screen.getByRole('button', { name: '5' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '10' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '20' })).toHaveAttribute('aria-pressed', 'false');
  });
});

interface ActiveTimerLoop {
  abort: () => void;
  settled: Promise<void>;
}

let activeTimerLoop: ActiveTimerLoop | null = null;

async function advanceInAct(ms: number): Promise<'advanced' | 'aborted'> {
  let abort!: () => void;
  const aborted = new Promise<'aborted'>((resolve) => {
    abort = () => resolve('aborted');
  });
  let markSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  const token: ActiveTimerLoop = { abort, settled };
  // Promise の executor は同期実行されるので、act() を呼ぶ前に必ず登録が完了している。
  // これが afterEach 側で「開いている act スコープが常に見つかる」ことの根拠。
  activeTimerLoop = token;
  try {
    return await act(async () =>
      Promise.race([
        vi.advanceTimersByTimeAsync(ms).then((): 'advanced' => 'advanced'),
        aborted,
      ]),
    );
  } finally {
    if (activeTimerLoop === token) {
      activeTimerLoop = null;
    }
    markSettled();
  }
}

// bdboard-ujnd: poll_failed テストが testTimeout で落ちたとき、本関数内の
// vi.advanceTimersByTimeAsync ループは vitest により中断されずバックグラウンドで
// 動き続ける。漏洩が確定するのは afterEach ではなくタイムアウトの瞬間である。
// act スコープが開いたままになると actQueue だけでなく actScopeDepth も 1 のまま漏れ、
// 以降の top-level act() は nested 分岐に落ちて漏れた配列を再利用する (flush も null 化もしない)。
// これが後続 render() が flush されず DOM が空になる連鎖の原因 (bdboard-gwgy の per-test
// timeout は予防策)。「useRealTimers() を後ろにずらせば漏れない」は誤りで、効くのは abort であって
// useRealTimers() との順序ではない。本チケットでは advanceInAct で abort 可能にし afterEach が
// act スコープ終了を待ってから useRealTimers() するので連鎖しない。
// bdboard-z231: 直線の advanceInAct 呼び出しは、TicketDetailPanel.test.tsx と違って
// 戻り値を捨ててよい。あちらは 'aborted' を受けたら必ず return する形になっているが、
// それは advance の後ろで render / user.click / fireEvent / モック再設定を行うテストがあり、
// timeout 済みの本体が abort 後に再開すると後続テストの DOM とモック呼び出し回数を汚すため
// (bdboard-d6b8。早期 return 無しだと失敗が 1 件でなく 3 件残った)。
// このファイルの直線サイトは advance の後ろが waitFor / expect の読み取りだけなので、
// 再開しても汚すものが無い。強制 timeout で実測しても、早期 return の有無で失敗件数は
// 変わらなかった (両起点とも 1 件。abort 自体を外すと 29 件 / 13 件に跳ねる)。
// つまり効いているのは abort であって早期 return ではない。ここに advance 後の DOM 操作を
// 増やす変更をするなら、TicketDetailPanel と同じ早期 return が必要になる。
async function finishBatchRunAfterPersistentPollFailures(): Promise<void> {
  for (let tick = 0; tick < NEXT_UP_LOOP_POLL_MAX_FAILURES * 4; tick += 1) {
    // abort は戻り値で伝播する。'aborted' を受けたら必ず return すること。return せずに次の反復へ進むと、
    // 新しい `aborted` promise が作られて abort が失われる。
    if ((await advanceInAct(NEXT_UP_LOOP_POLL_MAX_DELAY_MS)) === 'aborted') {
      return;
    }
    if (screen.queryByRole('button', { name: '▶ 一括実行' })) {
      return;
    }
  }
  throw new Error('batch run did not finish within timer budget');
}

describe('NextUpView batch run loop', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockPostTicketComment.mockResolvedValue(undefined);
    mockStartTicketRun.mockImplementation(async (ticketId) => ({
      runId: `run-${ticketId}`,
      ticketId,
      status: 'pending',
      worktreePath: `/tmp/worktrees/${ticketId}`,
      branchName: `bd/${ticketId}`,
      reused: false,
    }));
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  });

  afterEach(async () => {
    // vitest は suite 内の afterEach を RTL の root afterEach (import 時の自動 cleanup) より先に実行する。
    try {
      const loop = activeTimerLoop;
      if (loop) {
        loop.abort();
        await loop.settled;
      }
    } finally {
      // 塞いだのは act スコープの漏洩。abort が race に勝っても advanceTimersByTimeAsync は
      // デタッチされた clock 上で無害に走り続けることがある (タイマー/Promise を残さない、とは限らない)。
      vi.useRealTimers();
      vi.clearAllMocks();
    }
  });

  it('continues to the next ticket when the first run ends in failed', async () => {
    const cards = [
      makeCard('ticket-1', 'Task One'),
      makeCard('ticket-2', 'Task Two'),
    ];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockFetchAgentRun.mockImplementation(async (runId) => {
      if (runId === 'run-ticket-1') {
        return makeRunDetail(runId, 'ticket-1', 'failed');
      }
      if (runId === 'run-ticket-2') {
        return makeRunDetail(runId, 'ticket-2', 'succeeded');
      }
      throw new Error(`unexpected runId: ${runId}`);
    });

    await startBatchRun(user);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenNthCalledWith(1, 'ticket-1');
    });

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenNthCalledWith(2, 'ticket-2');
    });
  });

  it('does not start the next ticket after stop is requested', async () => {
    const cards = [
      makeCard('ticket-1', 'Task One'),
      makeCard('ticket-2', 'Task Two'),
    ];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockFetchAgentRun.mockImplementation(async (runId) => {
      if (runId === 'run-ticket-1') {
        return makeRunDetail(runId, 'ticket-1', 'running');
      }
      if (runId === 'run-ticket-2') {
        return makeRunDetail(runId, 'ticket-2', 'succeeded');
      }
      throw new Error(`unexpected runId: ${runId}`);
    });

    await startBatchRun(user);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: '■ 停止' }));

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS * 3);

    expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
  });

  it('keeps the last run summary visible after the batch loop finishes', async () => {
    const cards = [
      makeCard('ticket-1', 'Task One'),
      makeCard('ticket-2', 'Task Two'),
    ];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockFetchAgentRun.mockImplementation(async (runId) => {
      if (runId === 'run-ticket-1') {
        return makeRunDetail(runId, 'ticket-1', 'failed');
      }
      if (runId === 'run-ticket-2') {
        return makeRunDetail(runId, 'ticket-2', 'succeeded');
      }
      throw new Error(`unexpected runId: ${runId}`);
    });

    await startBatchRun(user);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenNthCalledWith(1, 'ticket-1');
    });

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenNthCalledWith(2, 'ticket-2');
    });

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeInTheDocument();
    });

    expect(
      screen.getByText(/前回の実行: 完走 \| 完了 1\/2 \| 失敗 1$/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/未実行/)).toBeNull();
  });

  it('returns to idle and stops polling when stop is pressed while a run never reaches terminal', async () => {
    const cards = [makeCard('ticket-1', 'Task One')];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockFetchAgentRun.mockImplementation(async (runId) =>
      makeRunDetail(runId, 'ticket-1', 'running'),
    );

    await startBatchRun(user);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: '■ 停止' }));

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeInTheDocument();
    });

    const fetchCountAfterStop = mockFetchAgentRun.mock.calls.length;

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS * 10);

    expect(mockFetchAgentRun.mock.calls.length).toBe(fetchCountAfterStop);
  });

  it('continues through every ticket while NextUpView is unmounted for a view switch', async () => {
    let resolveFirstPoll: ((detail: AgentRunDetailDto) => void) | undefined;
    const firstPollDeferred = new Promise<AgentRunDetailDto>((resolve) => {
      resolveFirstPoll = resolve;
    });
    const board = makeBoard([
      makeCard('ticket-1', 'Task One'),
      makeCard('ticket-2', 'Task Two'),
      makeCard('ticket-3', 'Task Three'),
    ]);

    mockFetchAgentRun.mockImplementation(async (runId) => {
      const ticketId = runId.replace(/^run-/, '');
      if (ticketId === 'ticket-1') {
        return firstPollDeferred;
      }
      return makeRunDetail(runId, ticketId, 'succeeded');
    });

    renderWithWatch(
      <ViewSwitchHarness
        board={board}
        limit={5}
        onLimitChange={vi.fn()}
        showEpics={false}
        onShowEpicsChange={vi.fn()}
        projectNames={projectNames}
        projectActiveSessions={projectActiveSessions}
        pendingDecisionIds={new Set()}
        prLinksById={new Map()}
        onCardClick={() => {}}
      />,
    );

    await startBatchRun(user);
    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: 'Kanban へ' }));
    expect(screen.queryByRole('region', { name: 'Next Up' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next Up へ' }));
    expect(screen.getByText(/現在: ticket-1/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Kanban へ' }));

    resolveFirstPoll!(makeRunDetail('run-ticket-1', 'ticket-1', 'succeeded'));
    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledTimes(3);
    });
    expect(mockStartTicketRun).toHaveBeenNthCalledWith(1, 'ticket-1');
    expect(mockStartTicketRun).toHaveBeenNthCalledWith(2, 'ticket-2');
    expect(mockStartTicketRun).toHaveBeenNthCalledWith(3, 'ticket-3');

    await user.click(screen.getByRole('button', { name: 'Next Up へ' }));
    await waitFor(() => {
      expect(screen.getByText(/前回の実行: 完走 \| 完了 3\/3 \| 失敗 0/)).toBeInTheDocument();
    });
  });

  it('stops polling after the controller owner unmounts', async () => {
    const cards = [makeCard('ticket-1', 'Task One')];
    const board = makeBoard(cards);
    const onLimitChange = vi.fn();
    const onShowEpicsChange = vi.fn();

    const { unmount } = renderWithWatch(
      <NextUpViewWithRunOwner
        board={board}
        limit={5}
        onLimitChange={onLimitChange}
        showEpics={false}
        onShowEpicsChange={onShowEpicsChange}
        projectNames={projectNames}
        projectActiveSessions={projectActiveSessions}
        pendingDecisionIds={new Set()}
        prLinksById={new Map()}
        onCardClick={() => {}}
      />,
    );

    mockFetchAgentRun.mockImplementation(async (runId) =>
      makeRunDetail(runId, 'ticket-1', 'running'),
    );

    await startBatchRun(user);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
    });

    const fetchCountAtUnmount = mockFetchAgentRun.mock.calls.length;
    unmount();

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS * 20);

    expect(mockFetchAgentRun.mock.calls.length).toBe(fetchCountAtUnmount);
  });

  it('shows describeRunStartError text when startTicketRun fails', async () => {
    const cards = [
      makeCard('ticket-1', 'Task One'),
      makeCard('ticket-2', 'Task Two'),
    ];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockStartTicketRun.mockRejectedValueOnce(
      new ApiError(
        409,
        '/tmp/worktrees/ticket-1: uncommitted changes prevent agent run',
        {
          errorMessage:
            '/tmp/worktrees/ticket-1: uncommitted changes prevent agent run',
          reason: 'worktree-dirty',
        },
      ),
    );

    await startBatchRun(user);

    expect(
      await screen.findByText(/未コミットの変更があるため実行できません/),
    ).toBeInTheDocument();
  });

  it('waits AGENT_RUN_POLL_INTERVAL_MS before starting the next ticket after start failure', async () => {
    const cards = [
      makeCard('ticket-1', 'Task One'),
      makeCard('ticket-2', 'Task Two'),
    ];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockStartTicketRun
      .mockRejectedValueOnce(
        new ApiError(429, 'too many concurrent runs', {
          errorMessage: 'too many concurrent runs',
        }),
      )
      .mockResolvedValueOnce({
        runId: 'run-ticket-2',
        ticketId: 'ticket-2',
        status: 'pending',
        worktreePath: '/tmp/worktrees/ticket-2',
        branchName: 'bd/ticket-2',
        reused: false,
      });

    mockFetchAgentRun.mockImplementation(async (runId) =>
      makeRunDetail(runId, 'ticket-2', 'succeeded'),
    );

    await startBatchRun(user);

    // タイマーを1msも進めずに microtask だけ流す。
    // start 失敗後の delay を削るミューテーションを入れると、ここで2件目が走るので落ちる。
    // waitFor は fake timers 検知時にコールバック評価前へ advanceTimersByTime(50) を挟むため、
    // 境界の検証には使えない（それが以前この検証を壊していた原因）。
    // advanceInAct に置き換えない: timer を進めない。マイクロタスクのみなので fake clock に依存せず、この経路では宙吊りにならない。
    await act(async () => {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
      }
    });

    expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
    expect(mockStartTicketRun).not.toHaveBeenCalledWith('ticket-2');

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenNthCalledWith(2, 'ticket-2');
    });
  });

  it('opens a confirmation dialog instead of starting immediately', async () => {
    const cards = [makeCard('ticket-1', 'Task One')];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    await openBatchRunConfirm(user);

    expect(
      screen.getByRole('alertdialog', { name: '一括実行の確認' }),
    ).toBeInTheDocument();
    expect(mockStartTicketRun).not.toHaveBeenCalled();
  });

  it('does not start when the confirmation dialog is cancelled', async () => {
    const cards = [makeCard('ticket-1', 'Task One')];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    await openBatchRunConfirm(user);
    const dialog = screen.getByRole('alertdialog', { name: '一括実行の確認' });
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(
      screen.queryByRole('alertdialog', { name: '一括実行の確認' }),
    ).not.toBeInTheDocument();
    expect(mockStartTicketRun).not.toHaveBeenCalled();
  });

  // 他の alertdialog と同じ useFocusTrap 経路に乗っていることの確認。
  // 初期フォーカスがキャンセル側にあること (= Enter の空打ちで実行されない)
  // と、Escape で閉じても実行が始まらないことの2点を押さえる。
  it('focuses cancel first and closes on Escape without starting', async () => {
    const cards = [makeCard('ticket-1', 'Task One')];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    await openBatchRunConfirm(user);
    const dialog = screen.getByRole('alertdialog', { name: '一括実行の確認' });

    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toHaveFocus();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(
        screen.queryByRole('alertdialog', { name: '一括実行の確認' }),
      ).not.toBeInTheDocument();
    });
    expect(mockStartTicketRun).not.toHaveBeenCalled();
  });

  it('starts the batch run when the confirmation dialog is accepted', async () => {
    const cards = [makeCard('ticket-1', 'Task One')];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockFetchAgentRun.mockImplementation(async (runId) =>
      makeRunDetail(runId, 'ticket-1', 'succeeded'),
    );

    await startBatchRun(user);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledWith('ticket-1');
    });
  });

  it('shows cancelled count separately from failed count', async () => {
    const cards = [
      makeCard('ticket-1', 'Task One'),
      makeCard('ticket-2', 'Task Two'),
    ];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockFetchAgentRun.mockImplementation(async (runId) => {
      if (runId === 'run-ticket-1') {
        return makeRunDetail(runId, 'ticket-1', 'cancelled');
      }
      if (runId === 'run-ticket-2') {
        return makeRunDetail(runId, 'ticket-2', 'succeeded');
      }
      throw new Error(`unexpected runId: ${runId}`);
    });

    await startBatchRun(user);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenNthCalledWith(2, 'ticket-2');
    });

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeInTheDocument();
    });

    expect(
      screen.getByText(/前回の実行: 完走 \| 完了 1\/2 \| 失敗 0 \| 中止 1$/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/未実行/)).toBeNull();
  });

  // App 相当の controller owner 自体をアンマウントして世代を切り替えた場合の remount UX。
  // 旧世代の遅延 poll 解決後も新 owner の進捗表示が ticket-2 のままであること。
  // 注: onProgress の世代ガード (M3) を削除しても本テストは通る — 旧 setProgress は
  // アンマウント済み hook 向けで React 18 は無言 no-op のため。理由は nextUpRunLoop.ts
  // のガードコメントおよび nextUpRunLoop.test.ts の M3/R10 ブロックを参照。
  it('does not let an unmounted loop generation overwrite progress after remount', async () => {
    let resolveFirstPoll: ((detail: AgentRunDetailDto) => void) | undefined;
    const firstPollDeferred = new Promise<AgentRunDetailDto>((resolve) => {
      resolveFirstPoll = resolve;
    });

    const cardsGen1 = [makeCard('ticket-1', 'Task One')];
    const onLimitChangeGen1 = vi.fn();
    const onShowEpicsChangeGen1 = vi.fn();

    const { unmount } = renderWithWatch(
      <NextUpViewWithRunOwner
        board={makeBoard(cardsGen1)}
        limit={5}
        onLimitChange={onLimitChangeGen1}
        showEpics={false}
        onShowEpicsChange={onShowEpicsChangeGen1}
        projectNames={projectNames}
        projectActiveSessions={projectActiveSessions}
        pendingDecisionIds={new Set()}
        prLinksById={new Map()}
        onCardClick={() => {}}
      />,
    );

    mockFetchAgentRun.mockImplementation(async (runId) => {
      if (runId === 'run-ticket-1') {
        return firstPollDeferred;
      }
      throw new Error(`unexpected runId: ${runId}`);
    });

    await startBatchRun(user);

    await waitFor(() => {
      expect(screen.getByText(/現在: ticket-1/)).toBeInTheDocument();
    });

    unmount();

    mockFetchAgentRun.mockReset();
    mockStartTicketRun.mockImplementation(async (ticketId) => ({
      runId: `run-${ticketId}`,
      ticketId,
      status: 'pending',
      worktreePath: `/tmp/worktrees/${ticketId}`,
      branchName: `bd/${ticketId}`,
      reused: false,
    }));

    renderNextUpView(makeBoard([makeCard('ticket-2', 'Task Two')]), { limit: 5 });

    mockFetchAgentRun.mockImplementation(async (runId) =>
      makeRunDetail(runId, 'ticket-2', 'running'),
    );

    await startBatchRun(user);

    await waitFor(() => {
      expect(screen.getByText(/現在: ticket-2/)).toBeInTheDocument();
    });

    resolveFirstPoll!(makeRunDetail('run-ticket-1', 'ticket-1', 'succeeded'));

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS * 5);

    expect(screen.getByText(/現在: ticket-2/)).toBeInTheDocument();
    expect(screen.queryByText(/現在: ticket-1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/完了 1\/1/)).not.toBeInTheDocument();
    expect(screen.getByText(/完了 0\/1/)).toBeInTheDocument();
  });

  it('does not get stuck in stopping when stop is clicked as the loop finishes', async () => {
    let resolveFirstPoll: ((detail: AgentRunDetailDto) => void) | undefined;
    const firstPollDeferred = new Promise<AgentRunDetailDto>((resolve) => {
      resolveFirstPoll = resolve;
    });

    const cards = [makeCard('ticket-1', 'Task One')];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockFetchAgentRun.mockImplementation(async (runId) => {
      if (runId === 'run-ticket-1') {
        return firstPollDeferred;
      }
      throw new Error(`unexpected runId: ${runId}`);
    });

    await startBatchRun(user);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '■ 停止' })).toBeInTheDocument();
    });

    const stopButton = screen.getByRole('button', { name: '■ 停止' });

    // advanceInAct に置き換えない: 複合 body。race に負けると fireEvent が act の外で発火してしまう。
    await act(async () => {
      resolveFirstPoll!(makeRunDetail('run-ticket-1', 'ticket-1', 'succeeded'));
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      fireEvent.click(stopButton);
    });

    expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '■ 停止中…' })).not.toBeInTheDocument();
    expect(screen.getByText(/前回の実行: 完走 \| 完了 1\/1 \| 失敗 0/)).toBeInTheDocument();
  });

  it('runs only visibleRegularCards up to the display limit', async () => {
    const cards = Array.from({ length: 8 }, (_, index) =>
      makeCard(`ticket-${index + 1}`, `Task ${index + 1}`),
    );
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockFetchAgentRun.mockImplementation(async (runId) => {
      const ticketId = runId.replace(/^run-/, '');
      return makeRunDetail(runId, ticketId, 'succeeded');
    });

    await startBatchRun(user);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledTimes(5);
    });

    expect(mockStartTicketRun).toHaveBeenNthCalledWith(1, 'ticket-1');
    expect(mockStartTicketRun).toHaveBeenNthCalledWith(5, 'ticket-5');
    expect(mockStartTicketRun).not.toHaveBeenCalledWith('ticket-6');
    expect(mockStartTicketRun).not.toHaveBeenCalledWith('ticket-7');
    expect(mockStartTicketRun).not.toHaveBeenCalledWith('ticket-8');

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS * 6);

    expect(mockStartTicketRun).toHaveBeenCalledTimes(5);
    expect(screen.getByText(/完了 5\/5/)).toBeInTheDocument();
  });

  // bdboard-gwgy: 'shows poll_failed summary ...' が高負荷時に5195msで落ちた実測があり、
  // 同じ20枚カード+バッチループの重いパターンを共有するこのdescribe内の他の20枚カード
  // テストにも予防的に同じper-test timeoutを揃える。
  it(
    'shows interrupted summary with remaining count when a 20-ticket batch stops on the second ticket',
    async () => {
      const cards = Array.from({ length: 20 }, (_, index) =>
        makeCard(`ticket-${index + 1}`, `Task ${index + 1}`),
      );
      renderNextUpView(makeBoard(cards), { limit: 20 });

      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        if (ticketId === 'ticket-1') {
          return makeRunDetail(runId, ticketId, 'succeeded');
        }
        return makeRunDetail(runId, ticketId, 'running');
      });

      await startBatchRun(user);

      await waitFor(() => {
        expect(mockStartTicketRun).toHaveBeenNthCalledWith(2, 'ticket-2');
      });

      await user.click(screen.getByRole('button', { name: '■ 停止' }));

      await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeInTheDocument();
      });

      expect(
        screen.getByText(
          /前回の実行: 中断 \| 完了 1\/20 \| 失敗 0 \| 実行中 1 \| 未実行 18/,
        ),
      ).toBeInTheDocument();
    },
    20000,
  );

  it(
    'shows poll_failed summary with unknown count and remaining when polling fails persistently',
    async () => {
      const cards = Array.from({ length: 20 }, (_, index) =>
        makeCard(`ticket-${index + 1}`, `Task ${index + 1}`),
      );
      renderNextUpView(makeBoard(cards), { limit: 20 });

      mockFetchAgentRun.mockRejectedValue(new Error('persistent poll error'));

      await startBatchRun(user);

      await waitFor(() => {
        expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
      });

      await finishBatchRunAfterPersistentPollFailures();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeInTheDocument();
      });

      expect(
        screen.getByText(
          /前回の実行: 中断\(状況を確認できず\) \| 完了 0\/20 \| 失敗 0 \| 不明 1 \| 未実行 19/,
        ),
      ).toBeInTheDocument();
    },
    20000,
  );

  // 回帰ガード(bdboard-ujnd) その1/2: タイムアウトで放置されたループを再現する。
  // この2件は対でひとつのガード。順序を変えたり間に別テストを挟んだりしないこと。
  // afterEach の abort 配線を外すと、開いたままの act スコープが次のテストへ漏れ、
  // 2件目の render が flush されずに落ちる。
  it('leaves a timer loop open when the batch run is abandoned (pairs with the next test)', async () => {
    const cards = Array.from({ length: 20 }, (_, index) =>
      makeCard(`ticket-${index + 1}`, `Task ${index + 1}`),
    );
    renderNextUpView(makeBoard(cards), { limit: 20 });
    mockFetchAgentRun.mockRejectedValue(new Error('persistent poll error'));

    await startBatchRun(user);
    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
    });

    // 意図的に await しない = テストがタイムアウトで見捨てられた状態の再現。
    void finishBatchRunAfterPersistentPollFailures().catch(() => undefined);
    await Promise.resolve();

    expect(activeTimerLoop).not.toBeNull();
  });

  // 回帰ガード(bdboard-ujnd) その2/2: 直前のテストが放置したループを afterEach が
  // 確実に閉じたことを、素の render が flush されるかどうかで観測する。
  it('renders normally after the previous test abandoned its timer loop', async () => {
    cleanup();
    render(<div>flushed</div>);
    expect(screen.getByText('flushed')).toBeInTheDocument();
  });

  it(
    'shows completed summary without interrupted wording when a 20-ticket batch finishes',
    async () => {
      const cards = Array.from({ length: 20 }, (_, index) =>
        makeCard(`ticket-${index + 1}`, `Task ${index + 1}`),
      );
      renderNextUpView(makeBoard(cards), { limit: 20 });

      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        return makeRunDetail(runId, ticketId, 'succeeded');
      });

      await startBatchRun(user);

      await waitFor(() => {
        expect(mockStartTicketRun).toHaveBeenCalledTimes(20);
      });

      await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS * 25);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeInTheDocument();
      });

      expect(
        screen.getByText(/前回の実行: 完走 \| 完了 20\/20 \| 失敗 0/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/中断/)).toBeNull();
      expect(screen.queryByText(/未実行/)).toBeNull();
    },
    20000,
  );

  it('shows consecutive-failure summary when two tickets fail in a row', async () => {
    const cards = [
      makeCard('ticket-1', 'Task One'),
      makeCard('ticket-2', 'Task Two'),
      makeCard('ticket-3', 'Task Three'),
    ];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    mockFetchAgentRun.mockImplementation(async (runId) => {
      const ticketId = runId.replace(/^run-/, '');
      return makeRunDetail(runId, ticketId, 'failed');
    });

    await startBatchRun(user);

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledTimes(2);
    });

    await advanceInAct(AGENT_RUN_POLL_INTERVAL_MS * 2);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeInTheDocument();
    });

    expect(
      screen.getByText(
        /前回の実行: 中断\(連続失敗\) \| 完了 0\/3 \| 失敗 2 \| 未実行 1/,
      ),
    ).toBeInTheDocument();
    expect(mockPostTicketComment).toHaveBeenCalledTimes(1);
  });

  it('shows that epics are excluded from batch run in the Epic section', () => {
    const cards = [
      makeCard('task-1', 'Task One'),
      makeCard('epic-1', 'Epic Alpha', 'proj-1', { issueType: 'epic', priority: 0 }),
    ];
    renderNextUpView(makeBoard(cards), { limit: 5, showEpics: true });

    expect(
      screen.getByText('Epic は「▶ 一括実行」の対象外です'),
    ).toBeInTheDocument();
  });
});


describe('NextUpView harness preflight', () => {
  const board = makeBoard([makeCard('bdboard-1', 'First')]);

  it('keeps the batch run button enabled while harness status is unknown', () => {
    renderNextUpView(board);

    expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeEnabled();
  });

  it('keeps the batch run button enabled when every project satisfies the preflight', () => {
    renderNextUpView(board, {
      harnessStatuses: new Map([['proj-1', harnessStatus()]]),
    });

    expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeEnabled();
  });

  it('disables the batch run button and names the project that needs fixing', () => {
    renderNextUpView(board, {
      harnessStatuses: new Map([['proj-1', harnessStatus({ state: 'missing' })]]),
    });

    expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeDisabled();
    expect(
      screen.getByText(
        'Project One: 検証ループ未定義 — .claude/bdboard-harness.json を作成',
      ),
    ).toBeInTheDocument();
  });

  it('disables the batch run button when the harness is not injected', () => {
    renderNextUpView(board, {
      harnessStatuses: new Map([
        ['proj-1', harnessStatus(OK_HARNESS_CONTRACT, null)],
      ]),
    });

    expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeDisabled();
    expect(
      screen.getByText('Project One: ハーネス未注入 — Hygiene から注入'),
    ).toBeInTheDocument();
  });

  it('ignores projects that are not among the visible cards', () => {
    renderNextUpView(board, {
      harnessStatuses: new Map([
        ['proj-1', harnessStatus()],
        ['proj-2', harnessStatus({ state: 'missing' })],
      ]),
    });

    expect(screen.getByRole('button', { name: '▶ 一括実行' })).toBeEnabled();
  });
});
