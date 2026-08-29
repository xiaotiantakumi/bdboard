import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type HygieneIssueDto, type LeaseHealthDto, type MergeSlotStatusDto } from '../api';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import {
  CONFLICT_WRITE_HELP,
  TUNNEL_WRITE_HELP,
} from '../writeAccessMessage';
import { HygienePanel } from './HygienePanel';

// bdboard-i759: 出力の時刻表記はboard timezoneに依存する。CIはUTC前提
// (Asia/Tokyo以外)なので、既存フィクスチャのJST前提の期待値を保つには
// 明示的にAsia/Tokyoへ固定する必要がある(ファイル内の全describeに適用)。
beforeEach(() => {
  setBoardTimeZoneOverride('Asia/Tokyo');
});

afterEach(() => {
  resetBoardTimeZoneForTests();
});

const showUndoMock = vi.fn();

/** HygienePanel.tsx の COPY_FEEDBACK_MS / REPAIR_FEEDBACK_MS と同じ値。 */
const COPY_FEEDBACK_MS = 2000;
const REPAIR_FEEDBACK_MS = 4000;

/**
 * spy 済みの window.setTimeout から、指定した遅延で仕掛けられたものだけ数える。
 * React 自身も setTimeout を使うので、素の呼び出し回数では区別できない。
 */
function timersArmedWith(
  spy: { mock: { calls: readonly unknown[][] } },
  delayMs: number,
): number {
  return spy.mock.calls.filter((call) => call[1] === delayMs).length;
}

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchHygieneIssues: vi.fn(),
    fetchLeaseHealth: vi.fn(),
    fetchMergeSlotStatus: vi.fn(),
    fetchAllHarnessStatus: vi.fn(),
    postProjectHarnessInject: vi.fn(),
    postTicketQuickAction: vi.fn(),
    postTicketQuickActionUndo: vi.fn(),
  };
});

vi.mock('../bdCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bdCommands')>();
  return {
    ...actual,
    copyTextToClipboard: vi.fn(),
  };
});

vi.mock('./UndoSnackbar', () => ({
  useUndoSnackbar: () => ({ showUndo: showUndoMock }),
  UndoSnackbarProvider: ({ children }: { children: ReactNode }) => children,
}));

import {
  fetchAllHarnessStatus,
  fetchHygieneIssues,
  fetchLeaseHealth,
  fetchMergeSlotStatus,
  postProjectHarnessInject,
  postTicketQuickAction,
  postTicketQuickActionUndo,
} from '../api';
import { copyTextToClipboard } from '../bdCommands';

const fetchHygieneIssuesMock = vi.mocked(fetchHygieneIssues);
const fetchLeaseHealthMock = vi.mocked(fetchLeaseHealth);
const fetchMergeSlotStatusMock = vi.mocked(fetchMergeSlotStatus);
const fetchAllHarnessStatusMock = vi.mocked(fetchAllHarnessStatus);
const postProjectHarnessInjectMock = vi.mocked(postProjectHarnessInject);
const postTicketQuickActionMock = vi.mocked(postTicketQuickAction);
const postTicketQuickActionUndoMock = vi.mocked(postTicketQuickActionUndo);
const copyTextToClipboardMock = vi.mocked(copyTextToClipboard);

function makeIssue(
  overrides: Partial<HygieneIssueDto> & Pick<HygieneIssueDto, 'ticketId' | 'kind'>,
): HygieneIssueDto {
  return {
    projectId: 'proj-1',
    message: 'Sample hygiene issue',
    severity: 'warning',
    ...overrides,
  };
}

function makeLeaseHealth(
  overrides?: Partial<LeaseHealthDto>,
): LeaseHealthDto {
  return {
    staleLeases: [],
    reclaim: {
      enabled: true,
      intervalMs: 300_000,
      olderThan: '10m',
      projects: [],
    },
    ...overrides,
  };
}

function makeMergeSlotStatus(
  overrides: Partial<MergeSlotStatusDto> & Pick<MergeSlotStatusDto, 'projectId'>,
): MergeSlotStatusDto {
  return {
    present: true,
    held: false,
    holder: null,
    heldSinceIso: null,
    heldForMs: 0,
    isLongHeld: false,
    ...overrides,
  };
}

function renderHygienePanel(
  options?: {
    projectIds?: readonly string[];
    onSelectTicket?: (ticketId: string) => void;
    projectRootPaths?: ReadonlyMap<string, string>;
    queryClient?: QueryClient;
  },
) {
  const queryClient =
    options?.queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

  const onSelectTicket = options?.onSelectTicket ?? vi.fn();

  const view = render(
    <QueryClientProvider client={queryClient}>
      <HygienePanel
        projectIds={options?.projectIds ?? []}
        onSelectTicket={onSelectTicket}
        projectRootPaths={options?.projectRootPaths}
      />
    </QueryClientProvider>,
  );

  return {
    onSelectTicket,
    container: view.container,
    queryClient,
    unmount: view.unmount,
  };
}

describe('HygienePanel', () => {
  beforeEach(() => {
    fetchHygieneIssuesMock.mockReset();
    fetchLeaseHealthMock.mockReset();
    fetchMergeSlotStatusMock.mockReset();
    fetchAllHarnessStatusMock.mockReset();
    postProjectHarnessInjectMock.mockReset();
    fetchHygieneIssuesMock.mockResolvedValue([]);
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth());
    fetchMergeSlotStatusMock.mockResolvedValue([]);
    fetchAllHarnessStatusMock.mockResolvedValue({ projects: [] });
    copyTextToClipboardMock.mockReset();
    copyTextToClipboardMock.mockResolvedValue(undefined);
    postTicketQuickActionMock.mockReset();
    postTicketQuickActionUndoMock.mockReset();
    showUndoMock.mockReset();
    postTicketQuickActionMock.mockResolvedValue(undefined);
    postTicketQuickActionUndoMock.mockResolvedValue(undefined);
  });

  it('renders hygiene issues with kind badges', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'defer_until を過ぎていますが、まだ deferred のままです',
      }),
      makeIssue({
        ticketId: 'bdboard-missing',
        kind: 'missing_priority',
        severity: 'info',
        message: 'priority が未設定または不正です',
      }),
    ]);

    renderHygienePanel();

    expect(await screen.findByText('期限超過の保留')).toBeInTheDocument();
    expect(screen.getByText('priority 未設定')).toBeInTheDocument();
    expect(
      screen.getByText('defer_until を過ぎていますが、まだ deferred のままです'),
    ).toBeInTheDocument();
  });

  it('shows an empty state when there are no issues', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([]);

    renderHygienePanel();

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
  });

  it('calls onSelectTicket with the clicked ticket id', async () => {
    const user = userEvent.setup();
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-click-me',
        kind: 'stale_epic',
        message: '子チケットはすべて完了していますが、エピックが open のままです',
      }),
    ]);

    const { onSelectTicket } = renderHygienePanel();

    await screen.findByText('完了済みエピック');
    await user.click(
      screen.getByRole('button', {
        name: /子チケットはすべて完了していますが、エピックが open のままです/,
      }),
    );

    expect(onSelectTicket).toHaveBeenCalledWith('bdboard-click-me');
  });

  it('passes projectIds to fetchHygieneIssues when provided', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([]);

    renderHygienePanel({ projectIds: ['proj-a', 'proj-b'] });

    await screen.findByText('警告はありません');

    expect(fetchHygieneIssuesMock).toHaveBeenCalledWith(['proj-a', 'proj-b']);
  });

  it('renders merged_leftover cleanup commands when cleanup is present', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-3tw.96',
        kind: 'merged_leftover',
        message: 'マージ済みだが worktree が残っています',
        cleanup: {
          repoRootPath: '/repo',
          worktreePath: '/repo/.claude/worktrees/bdboard-3tw.96',
          branchName: 'bd/bdboard-3tw.96',
        },
      }),
    ]);

    const { container } = renderHygienePanel();

    expect(await screen.findByText('残骸 worktree')).toBeInTheDocument();
    const cleanupCommand = container.querySelector('.hygiene-cleanup-command');
    expect(cleanupCommand).not.toBeNull();
    expect(cleanupCommand!.textContent).toBe(
      "git -C '/repo' worktree remove '/repo/.claude/worktrees/bdboard-3tw.96'\n" +
        "git -C '/repo' branch -d 'bd/bdboard-3tw.96'",
    );
  });

  it('copies cleanup commands and shows success feedback', async () => {
    const user = userEvent.setup();
    const cleanupScript =
      "git -C '/repo' worktree remove '/repo/.claude/worktrees/bdboard-3tw.96'\n" +
      "git -C '/repo' branch -d 'bd/bdboard-3tw.96'";

    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-3tw.96',
        kind: 'merged_leftover',
        message: 'マージ済みだが worktree が残っています',
        cleanup: {
          repoRootPath: '/repo',
          worktreePath: '/repo/.claude/worktrees/bdboard-3tw.96',
          branchName: 'bd/bdboard-3tw.96',
        },
      }),
    ]);

    renderHygienePanel();

    await screen.findByText('残骸 worktree');
    await user.click(screen.getByRole('button', { name: '掃除コマンドをコピー' }));

    expect(copyTextToClipboardMock).toHaveBeenCalledWith(cleanupScript);
    expect(await screen.findByText('掃除コマンドをコピーしました')).toBeInTheDocument();
  });

  it('does not arm a copy-feedback timer when the clipboard settles after unmount', async () => {
    // bdboard-ty72: コピー結果の表示は copyTextToClipboard の継続から出るので、
    // アンマウント後に解決すると、クリーンアップ済みのコンポーネントが新しい
    // setTimeout を仕掛けてしまう。残ったタイマーは破棄済み jsdom で
    // `window is not defined` を投げ、vitest はそれを「テスト環境破棄後の
    // 未捕捉エラー」としてプロセスごと exit 1 にする (bdboard-ifff)。
    const user = userEvent.setup();
    let settleCopy: (() => void) | undefined;
    copyTextToClipboardMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleCopy = () => {
            resolve();
          };
        }),
    );

    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-3tw.96',
        kind: 'merged_leftover',
        message: 'マージ済みだが worktree が残っています',
        cleanup: {
          repoRootPath: '/repo',
          worktreePath: '/repo/.claude/worktrees/bdboard-3tw.96',
          branchName: 'bd/bdboard-3tw.96',
        },
      }),
    ]);

    const { unmount } = renderHygienePanel();

    await screen.findByText('残骸 worktree');
    await user.click(screen.getByRole('button', { name: '掃除コマンドをコピー' }));
    await waitFor(() => {
      expect(copyTextToClipboardMock).toHaveBeenCalledTimes(1);
    });

    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    unmount();
    settleCopy?.();
    await act(async () => {
      await Promise.resolve();
    });

    expect(timersArmedWith(setTimeoutSpy, COPY_FEEDBACK_MS)).toBe(0);
    setTimeoutSpy.mockRestore();
  });

  it('does not render cleanup UI for issues without cleanup', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'defer_until を過ぎていますが、まだ deferred のままです',
      }),
    ]);

    renderHygienePanel();

    await screen.findByText('期限超過の保留');
    expect(screen.queryByRole('button', { name: '掃除コマンドをコピー' })).not.toBeInTheDocument();
  });

  it('still calls onSelectTicket when a merged_leftover row is clicked', async () => {
    const user = userEvent.setup();
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-merged-leftover',
        kind: 'merged_leftover',
        message: 'マージ済みだが worktree が残っています',
        cleanup: {
          repoRootPath: '/repo',
          worktreePath: '/repo/.claude/worktrees/bdboard-3tw.96',
          branchName: 'bd/bdboard-3tw.96',
        },
      }),
    ]);

    const { onSelectTicket } = renderHygienePanel();

    await screen.findByText('残骸 worktree');
    await user.click(
      screen.getByRole('button', {
        name: /マージ済みだが worktree が残っています/,
      }),
    );

    expect(onSelectTicket).toHaveBeenCalledWith('bdboard-merged-leftover');
  });

  it('renders dependency_cycle tickets as clickable links and removal commands', async () => {
    const user = userEvent.setup();
    const removalScript =
      "bd dep remove 'bdboard-a' 'bdboard-b'\n" +
      "bd dep remove 'bdboard-b' 'bdboard-a'";

    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-a',
        kind: 'dependency_cycle',
        message: 'blocks 依存に循環があります',
        cycleTicketIds: ['bdboard-a', 'bdboard-b'],
        cycleEdges: [
          { issueId: 'bdboard-a', dependsOnId: 'bdboard-b' },
          { issueId: 'bdboard-b', dependsOnId: 'bdboard-a' },
        ],
      }),
    ]);

    const { onSelectTicket, container } = renderHygienePanel();

    expect(await screen.findByText('循環依存')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'bdboard-a' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'bdboard-b' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'bdboard-a' }));
    expect(onSelectTicket).toHaveBeenCalledWith('bdboard-a');

    await user.click(screen.getByRole('button', { name: 'bdboard-b' }));
    expect(onSelectTicket).toHaveBeenCalledWith('bdboard-b');

    const cleanupCommand = container.querySelector('.hygiene-cleanup-command');
    expect(cleanupCommand).not.toBeNull();
    expect(cleanupCommand!.textContent).toBe(removalScript);
  });

  it('copies dependency_cycle removal commands and shows success feedback', async () => {
    const user = userEvent.setup();
    const removalScript =
      "bd dep remove 'bdboard-a' 'bdboard-b'\n" +
      "bd dep remove 'bdboard-b' 'bdboard-a'";

    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-a',
        kind: 'dependency_cycle',
        message: 'blocks 依存に循環があります',
        cycleTicketIds: ['bdboard-a', 'bdboard-b'],
        cycleEdges: [
          { issueId: 'bdboard-a', dependsOnId: 'bdboard-b' },
          { issueId: 'bdboard-b', dependsOnId: 'bdboard-a' },
        ],
      }),
    ]);

    renderHygienePanel();

    await screen.findByText('循環依存');
    await user.click(screen.getByRole('button', { name: '解消コマンドをコピー' }));

    expect(copyTextToClipboardMock).toHaveBeenCalledWith(removalScript);
    expect(await screen.findByText('掃除コマンドをコピーしました')).toBeInTheDocument();
  });

  it('includes -C in dependency_cycle removal commands when projectRootPaths is provided', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-a',
        projectId: 'proj-a',
        kind: 'dependency_cycle',
        message: 'blocks 依存に循環があります',
        cycleTicketIds: ['bdboard-a', 'bdboard-b'],
        cycleEdges: [
          { issueId: 'bdboard-a', dependsOnId: 'bdboard-b' },
          { issueId: 'bdboard-b', dependsOnId: 'bdboard-a' },
        ],
      }),
    ]);

    const projectRootPaths = new Map<string, string>([['proj-a', '/repo/root']]);
    const { container } = renderHygienePanel({ projectRootPaths });

    await screen.findByText('循環依存');
    const cleanupCommand = container.querySelector('.hygiene-cleanup-command');
    expect(cleanupCommand).not.toBeNull();
    expect(cleanupCommand!.textContent).toBe(
      "bd -C '/repo/root' dep remove 'bdboard-a' 'bdboard-b'\n" +
        "bd -C '/repo/root' dep remove 'bdboard-b' 'bdboard-a'",
    );
  });
});

describe('HygienePanel stale lease display', () => {
  beforeEach(() => {
    fetchHygieneIssuesMock.mockReset();
    fetchLeaseHealthMock.mockReset();
    fetchMergeSlotStatusMock.mockReset();
    fetchAllHarnessStatusMock.mockReset();
    fetchHygieneIssuesMock.mockResolvedValue([]);
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth());
    fetchMergeSlotStatusMock.mockResolvedValue([]);
    fetchAllHarnessStatusMock.mockResolvedValue({ projects: [] });
  });

  it('renders stale lease rows with ticket id, project, and elapsed duration', async () => {
    fetchLeaseHealthMock.mockResolvedValue(
      makeLeaseHealth({
        staleLeases: [
          {
            ticketId: 'bdboard-stale',
            projectId: 'proj-a',
            leaseExpiresAt: '2026-08-16T09:55:00.000Z',
            staleForMs: 300_000,
          },
        ],
        reclaim: {
          enabled: true,
          intervalMs: 300_000,
          olderThan: '10m',
          projects: [],
        },
      }),
    );

    renderHygienePanel();

    expect(await screen.findByText('stale lease（heartbeat 途絶）')).toBeInTheDocument();
    expect(screen.getByText('proj-a')).toBeInTheDocument();
    expect(screen.getByText('bdboard-stale')).toBeInTheDocument();
    expect(screen.getByText('lease 失効から 5分')).toBeInTheDocument();
  });

  it('shows empty state when there are no stale leases or other issues', async () => {
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth());

    renderHygienePanel();

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
    expect(
      screen.queryByText('stale lease（heartbeat 途絶）'),
    ).not.toBeInTheDocument();
  });

  it('passes projectIds to fetchLeaseHealth when provided', async () => {
    renderHygienePanel({ projectIds: ['proj-a', 'proj-b'] });

    await screen.findByText('警告はありません');

    expect(fetchLeaseHealthMock).toHaveBeenCalledWith(['proj-a', 'proj-b']);
  });

  it('calls onSelectTicket when a stale lease row is clicked', async () => {
    const user = userEvent.setup();
    fetchLeaseHealthMock.mockResolvedValue(
      makeLeaseHealth({
        staleLeases: [
          {
            ticketId: 'bdboard-stale-click',
            projectId: 'proj-a',
            leaseExpiresAt: '2026-08-16T09:55:00.000Z',
            staleForMs: 120_000,
          },
        ],
      }),
    );

    const { onSelectTicket } = renderHygienePanel();

    await screen.findByText('bdboard-stale-click');
    await user.click(screen.getByRole('button', { name: /lease 失効から 2分/ }));

    expect(onSelectTicket).toHaveBeenCalledWith('bdboard-stale-click');
  });

  it('shows reclaim run status within the stale lease section', async () => {
    fetchLeaseHealthMock.mockResolvedValue(
      makeLeaseHealth({
        staleLeases: [
          {
            ticketId: 'bdboard-stale',
            projectId: 'proj-a',
            leaseExpiresAt: '2026-08-16T09:55:00.000Z',
            staleForMs: 300_000,
          },
        ],
        reclaim: {
          enabled: true,
          intervalMs: 300_000,
          olderThan: '10m',
          projects: [
            {
              projectId: 'proj-a',
              lastRunAt: '2026-08-16T02:55:00.000Z',
              reclaimedCount: 1,
              reclaimedCountUnknown: false,
              rawSummary: 'reclaimed 1 issue',
              lastError: null,
            },
          ],
        },
      }),
    );

    renderHygienePanel();

    expect(await screen.findByText('stale lease（heartbeat 途絶）')).toBeInTheDocument();
    expect(screen.getByLabelText('自動 reclaim 状況')).toHaveTextContent(
      'proj-a: 最終実行 11:55 / 回収 1件',
    );
  });

  it('shows reclaim error in the stale lease section', async () => {
    fetchLeaseHealthMock.mockResolvedValue(
      makeLeaseHealth({
        staleLeases: [
          {
            ticketId: 'bdboard-stale',
            projectId: 'proj-a',
            leaseExpiresAt: '2026-08-16T09:55:00.000Z',
            staleForMs: 300_000,
          },
        ],
        reclaim: {
          enabled: true,
          intervalMs: 300_000,
          olderThan: '10m',
          projects: [
            {
              projectId: 'proj-a',
              lastRunAt: '2026-08-16T02:55:00.000Z',
              reclaimedCount: 0,
              reclaimedCountUnknown: false,
              rawSummary: null,
              lastError: 'bd reclaim failed',
            },
          ],
        },
      }),
    );

    renderHygienePanel();

    expect(await screen.findByText('stale lease（heartbeat 途絶）')).toBeInTheDocument();
    expect(screen.getByLabelText('自動 reclaim 状況')).toHaveTextContent(
      '/ エラー: bd reclaim failed',
    );
  });

  it('shows reclaim disabled message when scheduler is off', async () => {
    fetchLeaseHealthMock.mockResolvedValue(
      makeLeaseHealth({
        staleLeases: [
          {
            ticketId: 'bdboard-stale',
            projectId: 'proj-a',
            leaseExpiresAt: '2026-08-16T09:55:00.000Z',
            staleForMs: 300_000,
          },
        ],
        reclaim: {
          enabled: false,
          intervalMs: 300_000,
          olderThan: '10m',
          projects: [],
        },
      }),
    );

    renderHygienePanel();

    expect(await screen.findByText('自動 reclaim は無効です')).toBeInTheDocument();
  });

  it('does not render manual reclaim actions', async () => {
    fetchLeaseHealthMock.mockResolvedValue(
      makeLeaseHealth({
        staleLeases: [
          {
            ticketId: 'bdboard-stale',
            projectId: 'proj-a',
            leaseExpiresAt: '2026-08-16T09:55:00.000Z',
            staleForMs: 300_000,
          },
        ],
      }),
    );

    renderHygienePanel();

    await screen.findByText('bdboard-stale');
    expect(screen.queryByRole('button', { name: /reclaim/i })).not.toBeInTheDocument();
  });
});

describe('HygienePanel merge slot display', () => {
  beforeEach(() => {
    fetchHygieneIssuesMock.mockReset();
    fetchLeaseHealthMock.mockReset();
    fetchMergeSlotStatusMock.mockReset();
    fetchAllHarnessStatusMock.mockReset();
    fetchHygieneIssuesMock.mockResolvedValue([]);
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth());
    fetchMergeSlotStatusMock.mockResolvedValue([]);
    fetchAllHarnessStatusMock.mockResolvedValue({ projects: [] });
  });

  it('renders held merge slot with holder name and kind label', async () => {
    fetchMergeSlotStatusMock.mockResolvedValue([
      makeMergeSlotStatus({
        projectId: 'proj-a',
        held: true,
        holder: 'example-user',
        heldSinceIso: '2026-08-17T10:00:00.000Z',
        heldForMs: 300_000,
        isLongHeld: false,
      }),
    ]);

    renderHygienePanel();

    expect(await screen.findByText('マージスロット')).toBeInTheDocument();
    expect(screen.getByText('proj-a')).toBeInTheDocument();
    expect(screen.getByText('example-user')).toBeInTheDocument();
    expect(screen.getByText('保持中 5分')).toBeInTheDocument();
  });

  it('shows warning badge when merge slot is long held', async () => {
    fetchMergeSlotStatusMock.mockResolvedValue([
      makeMergeSlotStatus({
        projectId: 'proj-a',
        held: true,
        holder: 'example-user',
        heldForMs: 2_100_000,
        isLongHeld: true,
      }),
    ]);

    renderHygienePanel();

    expect(await screen.findByText('マージスロット')).toBeInTheDocument();
    expect(screen.getByText('警告')).toBeInTheDocument();
  });

  it('does not show warning badge when merge slot is not long held', async () => {
    fetchMergeSlotStatusMock.mockResolvedValue([
      makeMergeSlotStatus({
        projectId: 'proj-a',
        held: true,
        holder: 'example-user',
        heldForMs: 300_000,
        isLongHeld: false,
      }),
    ]);

    renderHygienePanel();

    expect(await screen.findByText('マージスロット')).toBeInTheDocument();
    expect(screen.queryByText('警告')).not.toBeInTheDocument();
  });

  it('does not render unheld merge slot entries', async () => {
    fetchMergeSlotStatusMock.mockResolvedValue([
      makeMergeSlotStatus({
        projectId: 'proj-a',
        held: false,
      }),
    ]);

    renderHygienePanel();

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
    expect(screen.queryByText('マージスロット')).not.toBeInTheDocument();
  });

  it('passes projectIds to fetchMergeSlotStatus when provided', async () => {
    renderHygienePanel({ projectIds: ['proj-a', 'proj-b'] });

    await screen.findByText('警告はありません');

    expect(fetchMergeSlotStatusMock).toHaveBeenCalledWith(['proj-a', 'proj-b']);
  });
});

describe('HygienePanel repair actions', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    fetchHygieneIssuesMock.mockReset();
    fetchLeaseHealthMock.mockReset();
    fetchMergeSlotStatusMock.mockReset();
    fetchAllHarnessStatusMock.mockReset();
    postProjectHarnessInjectMock.mockReset();
    fetchHygieneIssuesMock.mockResolvedValue([]);
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth());
    fetchMergeSlotStatusMock.mockResolvedValue([]);
    fetchAllHarnessStatusMock.mockResolvedValue({ projects: [] });
    postTicketQuickActionMock.mockReset();
    postTicketQuickActionUndoMock.mockReset();
    showUndoMock.mockReset();
    postTicketQuickActionMock.mockResolvedValue(undefined);
    postTicketQuickActionUndoMock.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  it('shows repair buttons only for repairable kinds', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
      }),
      makeIssue({
        ticketId: 'bdboard-epic',
        kind: 'stale_epic',
        message: 'stale epic',
      }),
      makeIssue({
        ticketId: 'bdboard-missing',
        kind: 'missing_priority',
        message: 'missing priority',
      }),
      makeIssue({
        ticketId: 'bdboard-stale',
        kind: 'stale_in_progress',
        message: 'stale in progress',
      }),
      makeIssue({
        ticketId: 'bdboard-idle',
        kind: 'unblocked_high_priority_idle',
        message: 'idle high priority',
      }),
      makeIssue({
        ticketId: 'bdboard-leftover',
        kind: 'merged_leftover',
        message: 'merged leftover',
      }),
    ]);

    renderHygienePanel();

    expect(await screen.findByRole('button', { name: '保留を解除' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'エピックを完了' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '優先度を設定' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '掃除コマンドをコピー' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /保留を解除|エピックを完了|優先度を設定/ })).toHaveLength(3);
  });

  it('requires confirmation before posting undefer quick action', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
        deferUntil: '2026-08-01',
      }),
    ]);

    renderHygienePanel();

    await screen.findByRole('button', { name: '保留を解除' });
    await user.click(screen.getByRole('button', { name: '保留を解除' }));

    expect(postTicketQuickActionMock).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: '確定: 保留を解除' }),
    );

    await waitFor(() => {
      expect(postTicketQuickActionMock).toHaveBeenCalledWith('bdboard-overdue', {
        action: 'undefer',
      });
    });
  });

  it('cancels undefer confirmation without posting', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
      }),
    ]);

    renderHygienePanel();

    await screen.findByRole('button', { name: '保留を解除' });
    await user.click(screen.getByRole('button', { name: '保留を解除' }));
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(postTicketQuickActionMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '保留を解除' })).toBeInTheDocument();
  });

  it('invalidates hygiene and board queries and shows undo snackbar on undefer success', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const overdueIssue = makeIssue({
      ticketId: 'bdboard-overdue',
      kind: 'overdue_defer',
      message: 'overdue defer',
      deferUntil: '2026-08-01',
    });

    fetchHygieneIssuesMock
      .mockResolvedValueOnce([overdueIssue])
      .mockResolvedValue([]);

    const { container } = renderHygienePanel({ queryClient });

    await screen.findByRole('button', { name: '保留を解除' });
    await user.click(screen.getByRole('button', { name: '保留を解除' }));
    await user.click(
      screen.getByRole('button', { name: '確定: 保留を解除' }),
    );

    await waitFor(() => {
      expect(postTicketQuickActionMock).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['hygiene'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['board'] });
    });

    expect(showUndoMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: '保留を解除しました' }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: '保留を解除' }),
      ).not.toBeInTheDocument();
    });

    const repairStatus = container.querySelector('.hygiene-panel-repair-status');
    expect(repairStatus).toHaveTextContent('保留を解除しました: bdboard-overdue');
  });

  it('does not arm a repair-status timer when the mutation settles after unmount', async () => {
    // bdboard-ty72: 修復ステータスの表示は invalidateQueries を2本 await した
    // 後に出るので、コピーと同じ経路でアンマウント後に走りうる。タイマーIDを
    // ref に持っていても、クリーンアップはもう走り終わっている。
    let settlePost: (() => void) | undefined;
    postTicketQuickActionMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settlePost = () => {
            resolve();
          };
        }),
    );
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
        deferUntil: '2026-08-01',
      }),
    ]);

    const { unmount } = renderHygienePanel();

    await screen.findByRole('button', { name: '保留を解除' });
    await user.click(screen.getByRole('button', { name: '保留を解除' }));
    await user.click(screen.getByRole('button', { name: '確定: 保留を解除' }));
    await waitFor(() => {
      expect(postTicketQuickActionMock).toHaveBeenCalledTimes(1);
    });

    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    unmount();
    settlePost?.();
    await act(async () => {
      // invalidateQueries を2本挟むので、マイクロタスクを数回流す。
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(timersArmedWith(setTimeoutSpy, REPAIR_FEEDBACK_MS)).toBe(0);
    setTimeoutSpy.mockRestore();
  });

  it('does not show undo snackbar when deferUntil is missing on overdue_defer success', async () => {
    const overdueIssue = makeIssue({
      ticketId: 'bdboard-overdue',
      kind: 'overdue_defer',
      message: 'overdue defer without deferUntil',
    });

    fetchHygieneIssuesMock
      .mockResolvedValueOnce([overdueIssue])
      .mockResolvedValue([]);

    const { container } = renderHygienePanel();

    await screen.findByRole('button', { name: '保留を解除' });
    await user.click(screen.getByRole('button', { name: '保留を解除' }));
    await user.click(
      screen.getByRole('button', { name: '確定: 保留を解除' }),
    );

    await waitFor(() => {
      expect(postTicketQuickActionMock).toHaveBeenCalled();
    });

    expect(showUndoMock).not.toHaveBeenCalled();

    const repairStatus = container.querySelector('.hygiene-panel-repair-status');
    expect(repairStatus).toHaveTextContent('保留を解除しました: bdboard-overdue');
  });

  it('shows row alert on 403 failure without success feedback or undo snackbar', async () => {
    postTicketQuickActionMock.mockRejectedValue(
      new ApiError(403, 'local access only', {
        errorMessage: 'local access only',
      }),
    );
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
        deferUntil: '2026-08-01',
      }),
    ]);

    renderHygienePanel();

    await screen.findByRole('button', { name: '保留を解除' });
    await user.click(screen.getByRole('button', { name: '保留を解除' }));
    await user.click(
      screen.getByRole('button', { name: '確定: 保留を解除' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(TUNNEL_WRITE_HELP);
    expect(screen.queryByText('保留を解除しました')).not.toBeInTheDocument();
    expect(showUndoMock).not.toHaveBeenCalled();
  });

  it('shows row alert on 409 failure with conflict help', async () => {
    postTicketQuickActionMock.mockRejectedValue(
      new ApiError(409, 'conflict', { errorMessage: 'conflict' }),
    );
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
      }),
    ]);

    renderHygienePanel();

    await screen.findByRole('button', { name: '保留を解除' });
    await user.click(screen.getByRole('button', { name: '保留を解除' }));
    await user.click(
      screen.getByRole('button', { name: '確定: 保留を解除' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(CONFLICT_WRITE_HELP);
    expect(showUndoMock).not.toHaveBeenCalled();
  });

  it('disables repair buttons while mutation is pending', async () => {
    let resolveAction: (() => void) | undefined;
    postTicketQuickActionMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        }),
    );
    fetchHygieneIssuesMock.mockResolvedValue([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
      }),
      makeIssue({
        ticketId: 'bdboard-epic',
        kind: 'stale_epic',
        message: 'stale epic',
      }),
    ]);

    renderHygienePanel();

    await screen.findByRole('button', { name: '保留を解除' });
    await user.click(screen.getByRole('button', { name: '保留を解除' }));
    await user.click(
      screen.getByRole('button', { name: '確定: 保留を解除' }),
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '実行中…' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'エピックを完了' })).toBeDisabled();

    resolveAction?.();
    await waitFor(() => {
      expect(postTicketQuickActionMock).toHaveBeenCalled();
    });
  });

  it('posts selected priority for missing_priority and shows header success without undo', async () => {
    const missingIssue = makeIssue({
      ticketId: 'bdboard-missing',
      kind: 'missing_priority',
      message: 'missing priority',
    });

    fetchHygieneIssuesMock
      .mockResolvedValueOnce([missingIssue])
      .mockResolvedValue([]);

    const { container } = renderHygienePanel();

    await screen.findByRole('button', { name: '優先度を設定' });
    await user.selectOptions(screen.getByRole('combobox'), '0');
    await user.click(screen.getByRole('button', { name: '優先度を設定' }));
    await user.click(
      screen.getByRole('button', { name: '確定: 優先度を設定' }),
    );

    await waitFor(() => {
      expect(postTicketQuickActionMock).toHaveBeenCalledWith('bdboard-missing', {
        action: 'priority',
        priority: 0,
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: '優先度を設定' }),
      ).not.toBeInTheDocument();
    });

    const repairStatus = container.querySelector('.hygiene-panel-repair-status');
    expect(repairStatus).toHaveTextContent(
      '優先度を P0 に設定しました: bdboard-missing',
    );
    expect(showUndoMock).not.toHaveBeenCalled();
  });

  it('closes stale epic and shows header success message when row disappears', async () => {
    const epicIssue = makeIssue({
      ticketId: 'bdboard-epic',
      kind: 'stale_epic',
      message: 'stale epic',
    });

    fetchHygieneIssuesMock
      .mockResolvedValueOnce([epicIssue])
      .mockResolvedValue([]);

    const { container } = renderHygienePanel();

    await screen.findByRole('button', { name: 'エピックを完了' });
    await user.click(screen.getByRole('button', { name: 'エピックを完了' }));
    await user.click(
      screen.getByRole('button', { name: '確定: エピックを完了' }),
    );

    await waitFor(() => {
      expect(postTicketQuickActionMock).toHaveBeenCalledWith('bdboard-epic', {
        action: 'close',
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'エピックを完了' }),
      ).not.toBeInTheDocument();
    });

    const repairStatus = container.querySelector('.hygiene-panel-repair-status');
    expect(repairStatus).toHaveTextContent(
      'エピックを完了しました: bdboard-epic',
    );
  });

  it('shows harness version drift items with update repair flow', async () => {
    const user = userEvent.setup();
    fetchHygieneIssuesMock.mockResolvedValue([]);
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.1.0',
              drift: true,
            },
          ],
        },
      ],
    });
    postProjectHarnessInjectMock.mockResolvedValue({
      packs: [
        {
          name: 'bdboard-harness',
          availableVersion: '0.2.0',
          installedVersion: '0.2.0',
          drift: false,
        },
      ],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(await screen.findByText('ハーネス要更新')).toBeInTheDocument();
    expect(
      screen.getByText('bdboard-harness: v0.1.0 → v0.2.0 に更新が必要です'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'ハーネスを更新' }));
    await user.click(screen.getByRole('button', { name: '確定: ハーネスを更新' }));

    await waitFor(() => {
      expect(postProjectHarnessInjectMock).toHaveBeenCalledWith(
        '/tmp/proj-a',
        'bdboard-harness',
      );
    });
  });

  it('shows empty message only when hygiene and harness drift are both clear', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([]);
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.2.0',
              drift: false,
            },
          ],
        },
      ],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
  });

  it('shows inject failure on harness drift repair', async () => {
    const user = userEvent.setup();
    fetchHygieneIssuesMock.mockResolvedValue([]);
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.1.0',
              drift: true,
            },
          ],
        },
      ],
    });
    postProjectHarnessInjectMock.mockRejectedValue(
      new ApiError(500, 'injection failed', {
        errorMessage: 'injection failed',
        detail: 'disk full',
      }),
    );

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    await screen.findByText('ハーネス要更新');
    await user.click(screen.getByRole('button', { name: 'ハーネスを更新' }));
    await user.click(screen.getByRole('button', { name: '確定: ハーネスを更新' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('injection failed');
  });

  it('shows drift only for selected projects', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([]);
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.1.0',
              drift: true,
            },
          ],
        },
        {
          projectId: '/tmp/proj-b',
          packs: [
            {
              name: 'other-pack',
              availableVersion: '0.3.0',
              installedVersion: '0.1.0',
              drift: true,
            },
          ],
        },
      ],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(
      await screen.findByText('bdboard-harness: v0.1.0 → v0.2.0 に更新が必要です'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/other-pack/)).not.toBeInTheDocument();
  });

  it('shows drift for all projects when no project is selected', async () => {
    fetchHygieneIssuesMock.mockResolvedValue([]);
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.1.0',
              drift: true,
            },
          ],
        },
        {
          projectId: '/tmp/proj-b',
          packs: [
            {
              name: 'other-pack',
              availableVersion: '0.3.0',
              installedVersion: '0.1.0',
              drift: true,
            },
          ],
        },
      ],
    });

    renderHygienePanel({ projectIds: [] });

    expect(
      await screen.findByText('bdboard-harness: v0.1.0 → v0.2.0 に更新が必要です'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('other-pack: v0.1.0 → v0.3.0 に更新が必要です'),
    ).toBeInTheDocument();
  });
});
