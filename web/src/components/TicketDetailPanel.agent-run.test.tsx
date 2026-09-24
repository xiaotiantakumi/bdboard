// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「agent-run」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunDetailDto } from '../api';
import {
  ApiError,
  fetchTicket,
  fetchTicketComments,
  fetchSimilarTickets,
  fetchPlatformSupport,
  startTicketRun,
  fetchTicketRuns,
  fetchTicketInFlightOverlaps,
  fetchAgentRun,
  cancelAgentRun,
  fetchProjectHarnessStatus,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { harnessStatus, renderPanel, sampleTicket } from './TicketDetailPanel-test-support';
import { AGENT_RUN_LOG_LOCAL_ONLY_HELP } from './TicketDetailPanel';
import {
  CONFLICT_WRITE_HELP,
  REMOTE_AGENT_RUNS_DISABLED_HELP,
} from '../writeAccessMessage';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchTicket: vi.fn(),
    fetchTicketComments: vi.fn(),
    fetchSimilarTickets: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    startTicketRun: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockFetchPlatformSupport = vi.mocked(fetchPlatformSupport);
const mockStartTicketRun = vi.mocked(startTicketRun);
const mockFetchTicketRuns = vi.mocked(fetchTicketRuns);
const mockFetchTicketInFlightOverlaps = vi.mocked(fetchTicketInFlightOverlaps);
const mockFetchAgentRun = vi.mocked(fetchAgentRun);
const mockCancelAgentRun = vi.mocked(cancelAgentRun);
const mockFetchProjectHarnessStatus = vi.mocked(fetchProjectHarnessStatus);

beforeEach(() => {
  mockFetchSimilarTickets.mockResolvedValue([]);
  mockFetchTicketRuns.mockResolvedValue({ runs: [] });
  mockFetchTicketInFlightOverlaps.mockResolvedValue([]);
  resetPlatformSupportCache();
  mockFetchPlatformSupport.mockResolvedValue({ platform: 'darwin', limitations: [] });
  mockFetchProjectHarnessStatus.mockResolvedValue(harnessStatus());
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

// bdboard-d6b8: per-test timeout が act の内側で発火しても Vitest はテスト Promise をキャンセルしない。
// afterEach から advanceInAct を abort して settled を待つことで、実際に漏れた act スコープを閉じる。
// これは vi.useRealTimers() の順序で解消する問題ではない。呼び出し側は 'aborted' を受けたら必ず
// return すること。続行すると timeout 済みのテスト本体が再開し、後続テストの DOM とモック呼び出し
// 回数を汚染する（実測では return 無しだと起点を含む失敗が 1 件ではなく 3 件残った）。
describe('TicketDetailPanel agent run', () => {
  let user: ReturnType<typeof userEvent.setup>;

  const runningRunDetail: AgentRunDetailDto = {
    id: 'run-1',
    ticketId: sampleTicket.id,
    runner: 'claude',
    mode: 'spawn',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/worktrees/bdboard-abc.1',
    log: 'starting claude\n',
  };

  const succeededRunDetail: AgentRunDetailDto = {
    ...runningRunDetail,
    status: 'succeeded',
    finishedAt: '2026-01-01T00:05:00.000Z',
    exitCode: 0,
    log: 'starting claude\ndone\n',
  };

  const cancellingRunDetail: AgentRunDetailDto = {
    ...runningRunDetail,
    status: 'cancelling',
  };

  const cancelledRunDetail: AgentRunDetailDto = {
    ...runningRunDetail,
    status: 'cancelled',
    finishedAt: '2026-01-01T00:03:00.000Z',
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockFetchTicketRuns.mockResolvedValue({ runs: [] });
    mockStartTicketRun.mockResolvedValue({
      runId: 'run-1',
      ticketId: sampleTicket.id,
      status: 'pending',
      worktreePath: '/tmp/worktrees/bdboard-abc.1',
      branchName: 'bd/bdboard-abc.1',
      reused: false,
    });
    mockFetchAgentRun.mockResolvedValue(runningRunDetail);
    mockCancelAgentRun.mockResolvedValue({ runId: 'run-1', status: 'cancelling' });
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  });

  afterEach(async () => {
    try {
      const loop = activeTimerLoop;
      if (loop) {
        loop.abort();
        await loop.settled;
      }
    } finally {
      vi.useRealTimers();
      vi.resetAllMocks();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('disables the run button when the ticket is blocked', async () => {
    mockFetchTicket.mockResolvedValue({
      ...sampleTicket,
      blockedBy: ['other'],
    });

    renderPanel(new Map());

    const runButton = await screen.findByRole('button', { name: '▶ 実行' });
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveAttribute('title', 'ブロック中のチケットは実行できません');
  });

  /*
   * エージェント実行の前提 (bdboard-pkr6.11)。サーバー側 preflight と同じ 3 条件を
   * ボタンの手前で出す。文言はチケットの仕様どおり「何をすれば直るか」まで含める。
   */
  it('disables the run button and explains an uninjected harness', async () => {
    mockFetchProjectHarnessStatus.mockResolvedValue({
      packs: [],
      contract: { state: 'not-applicable' },
    });

    renderPanel(new Map());

    expect(
      await screen.findByText('ハーネス未注入 — Hygiene から注入'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▶ 実行' })).toBeDisabled();
  });

  it('disables the run button when harness hooks are not registered', async () => {
    mockFetchProjectHarnessStatus.mockResolvedValue(
      harnessStatus({ hooksState: 'missing', missingHooks: ['guard.sh'] }),
    );

    renderPanel(new Map());

    expect(await screen.findByText('hook 未登録 — 再注入')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▶ 実行' })).toBeDisabled();
  });

  it('disables the run button when the verification contract is missing', async () => {
    mockFetchProjectHarnessStatus.mockResolvedValue(
      harnessStatus({}, { state: 'missing' }),
    );

    renderPanel(new Map());

    expect(
      await screen.findByText('検証ループ未定義 — .claude/bdboard-harness.json を作成'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▶ 実行' })).toBeDisabled();
  });

  it('keeps the run button enabled when the harness is only drifting', async () => {
    mockFetchProjectHarnessStatus.mockResolvedValue(
      harnessStatus({ installedVersion: '0.9.0', drift: true }),
    );

    renderPanel(new Map());

    await waitFor(() => {
      expect(mockFetchProjectHarnessStatus).toHaveBeenCalled();
    });
    expect(screen.getByRole('button', { name: '▶ 実行' })).toBeEnabled();
  });

  it('shows the verify command to run outside the run once it finishes', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });
    mockFetchAgentRun.mockResolvedValue({
      ...succeededRunDetail,
      nextStep: {
        verify: 'npm run verify',
        worktreePath: '/tmp/worktrees/bdboard-abc.1',
      },
    });

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    const command = 'cd /tmp/worktrees/bdboard-abc.1 && npm run verify';
    expect(await screen.findByText(command)).toBeInTheDocument();
    expect(screen.getByText('次に実行:')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: `次に実行するコマンドをコピー: ${command}` }),
    );
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(command);
    });
  });

  it('starts a run and shows worktree metadata after confirmation', async () => {
    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledWith(sampleTicket.id);
    });

    expect(await screen.findByText('/tmp/worktrees/bdboard-abc.1')).toBeInTheDocument();
    expect(screen.getByText('bd/bdboard-abc.1')).toBeInTheDocument();
    expect(screen.getByText('新規作成')).toBeInTheDocument();
  });

  it('polls while running and stops after a terminal status', async () => {
    mockFetchAgentRun
      .mockResolvedValueOnce(runningRunDetail)
      .mockResolvedValueOnce(runningRunDetail)
      .mockResolvedValueOnce(succeededRunDetail);

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(1);
    });

    if ((await advanceInAct(2000)) === 'aborted') {
      return;
    }
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(2);
    });

    if ((await advanceInAct(2000)) === 'aborted') {
      return;
    }
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(3);
    });

    const callCountAfterTerminal = mockFetchAgentRun.mock.calls.length;

    if ((await advanceInAct(4000)) === 'aborted') {
      return;
    }

    expect(mockFetchAgentRun.mock.calls.length).toBe(callCountAfterTerminal);
    expect(await screen.findByText(/状態: 成功/)).toBeInTheDocument();
  });

  it('shows local-only guidance when run log is restricted', async () => {
    mockFetchAgentRun.mockResolvedValue({
      ...runningRunDetail,
      cwd: undefined,
      log: '',
      logRestricted: true,
    });

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(AGENT_RUN_LOG_LOCAL_ONLY_HELP),
    ).toBeInTheDocument();
    expect(screen.queryByText('starting claude')).not.toBeInTheDocument();
  });

  it('shows remote-run disabled help on 403', async () => {
    mockStartTicketRun.mockRejectedValue(
      new ApiError(403, 'remote agent runs are disabled', {
        errorMessage: 'remote agent runs are disabled',
      }),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(REMOTE_AGENT_RUNS_DISABLED_HELP),
    ).toBeInTheDocument();
  });

  it('shows a dedicated message when worktree is dirty (409 reason=worktree-dirty)', async () => {
    mockStartTicketRun.mockRejectedValue(
      new ApiError(
        409,
        '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
        {
          errorMessage:
            '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
          reason: 'worktree-dirty',
        },
      ),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(/未コミットの変更があるため実行できません/),
    ).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/worktrees\/bdboard-abc\.1/)).toBeInTheDocument();
  });

  it('still renders the dirty-worktree message when the path is absent from the message', async () => {
    mockStartTicketRun.mockRejectedValue(
      new ApiError(409, 'worktree has uncommitted changes', {
        errorMessage: 'worktree has uncommitted changes',
        reason: 'worktree-dirty',
      }),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(/未コミットの変更があるため実行できません/),
    ).toBeInTheDocument();
  });

  it('shows a dedicated message when worktree is on a different branch (409 reason=worktree-branch-mismatch)', async () => {
    mockStartTicketRun.mockRejectedValue(
      new ApiError(
        409,
        '/tmp/worktrees/bdboard-abc.1: on branch main, expected bd/bdboard-abc.1',
        {
          errorMessage:
            '/tmp/worktrees/bdboard-abc.1: on branch main, expected bd/bdboard-abc.1',
          reason: 'worktree-branch-mismatch',
        },
      ),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(/別のブランチ（main）にあるため実行できません/),
    ).toBeInTheDocument();
  });

  it('still renders the branch-mismatch message when the branch name is absent from the message', async () => {
    mockStartTicketRun.mockRejectedValue(
      new ApiError(409, 'worktree branch mismatch', {
        errorMessage: 'worktree branch mismatch',
        reason: 'worktree-branch-mismatch',
      }),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(/別のブランチにあるため実行できません/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/別のブランチ（/)).not.toBeInTheDocument();
  });

  it('does not claim a dirty worktree for a 409 that carries no reason', async () => {
    // 判定が `reason` ではなくメッセージの文字列一致に退行したら、この
    // ケースが誤って dirty-worktree 扱いになるので落ちる。
    mockStartTicketRun.mockRejectedValue(
      new ApiError(
        409,
        '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
        {
          errorMessage:
            '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
        },
      ),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    // reason が無い 409 は describeWriteError の汎用 409 分岐に落ちる。
    expect(await screen.findByText(CONFLICT_WRITE_HELP)).toBeInTheDocument();
    expect(
      screen.queryByText(/未コミットの変更があるため実行できません/),
    ).not.toBeInTheDocument();
  });

  it('stops polling after three consecutive failures and re-enables the run button', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchAgentRun.mockRejectedValue(new Error('boom'));

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(1);
    });

    if ((await advanceInAct(2000)) === 'aborted') {
      return;
    }
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(2);
    });

    if ((await advanceInAct(2000)) === 'aborted') {
      return;
    }
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(3);
    });

    const callCountAfterStop = mockFetchAgentRun.mock.calls.length;

    if ((await advanceInAct(6000)) === 'aborted') {
      return;
    }

    expect(mockFetchAgentRun.mock.calls.length).toBe(callCountAfterStop);
    expect(screen.getByText(/状態を取得できません/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▶ 実行' })).not.toBeDisabled();
  });

  it('keeps polling while cancelling and stops after cancelled', async () => {
    mockFetchAgentRun
      .mockResolvedValueOnce(runningRunDetail)
      .mockResolvedValueOnce(cancellingRunDetail)
      .mockResolvedValueOnce(cancellingRunDetail)
      .mockResolvedValueOnce(cancelledRunDetail);

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(1);
    });

    if ((await advanceInAct(2000)) === 'aborted') {
      return;
    }
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '中止中…' }),
      ).toBeDisabled();
    });

    if ((await advanceInAct(2000)) === 'aborted') {
      return;
    }
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(3);
    });

    if ((await advanceInAct(2000)) === 'aborted') {
      return;
    }
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(4);
    });

    const callCountAfterTerminal = mockFetchAgentRun.mock.calls.length;

    if ((await advanceInAct(4000)) === 'aborted') {
      return;
    }

    expect(mockFetchAgentRun.mock.calls.length).toBe(callCountAfterTerminal);
    expect(await screen.findByText(/状態: 中止/)).toBeInTheDocument();
  });

  it('shows reused worktree label when the server reuses an existing worktree', async () => {
    mockStartTicketRun.mockResolvedValue({
      runId: 'run-1',
      ticketId: sampleTicket.id,
      status: 'pending',
      worktreePath: '/tmp/worktrees/bdboard-abc.1',
      branchName: 'bd/bdboard-abc.1',
      reused: true,
    });

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(await screen.findByText('既存を再利用')).toBeInTheDocument();
  });
});
