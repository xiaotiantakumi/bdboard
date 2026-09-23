// bdboard-sso1.85: HygienePanel.test.tsx (2453行) から move-only で分割した
// 「一覧表示・種類別バッジ・行クリック」関心のファイル。関数本体・アサーション・
// フィクスチャの値は元ファイルから1文字も変えていない。
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatWorktreeCleanupScript, formatHeartbeatLoopKillScript } from '../bdCommands';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import {
  makeHygieneResponse,
  makeIssue,
  makeLeaseHealth,
  renderHygienePanel,
  timersArmedWith,
} from './HygienePanel-test-support';

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

/** HygienePanel.tsx の COPY_FEEDBACK_MS と同じ値。 */
const COPY_FEEDBACK_MS = 2000;

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchHygiene: vi.fn(),
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
  fetchHygiene,
  fetchLeaseHealth,
  fetchMergeSlotStatus,
  postProjectHarnessInject,
  postTicketQuickAction,
  postTicketQuickActionUndo,
} from '../api';
import { copyTextToClipboard } from '../bdCommands';

const fetchHygieneMock = vi.mocked(fetchHygiene);
const fetchLeaseHealthMock = vi.mocked(fetchLeaseHealth);
const fetchMergeSlotStatusMock = vi.mocked(fetchMergeSlotStatus);
const fetchAllHarnessStatusMock = vi.mocked(fetchAllHarnessStatus);
const postProjectHarnessInjectMock = vi.mocked(postProjectHarnessInject);
const postTicketQuickActionMock = vi.mocked(postTicketQuickAction);
const postTicketQuickActionUndoMock = vi.mocked(postTicketQuickActionUndo);
const copyTextToClipboardMock = vi.mocked(copyTextToClipboard);

describe('HygienePanel', () => {
  beforeEach(() => {
    fetchHygieneMock.mockReset();
    fetchLeaseHealthMock.mockReset();
    fetchMergeSlotStatusMock.mockReset();
    fetchAllHarnessStatusMock.mockReset();
    postProjectHarnessInjectMock.mockReset();
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'defer_until を過ぎていますが、まだ deferred のままです',
      }),
      makeIssue({
        ticketId: 'bdboard-stale',
        kind: 'stale_in_progress',
        severity: 'warning',
        message: 'in_progress のまま 30 日以上経過しています',
      }),
    ]));

    renderHygienePanel();

    expect(await screen.findByText('期限超過の保留')).toBeInTheDocument();
    expect(screen.getByText('長期 in_progress')).toBeInTheDocument();
    expect(
      screen.getByText('defer_until を過ぎていますが、まだ deferred のままです'),
    ).toBeInTheDocument();
  });

  it('renders closed_without_evidence label without a repair button', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-closed',
        kind: 'closed_without_evidence',
        severity: 'info',
        message:
          'close 済みだが PR/検証の記録がない（close-template.md の書式でコメントを残す）',
      }),
    ]));

    renderHygienePanel();

    expect(await screen.findByText('close 証拠なし')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /保留を解除|エピックを完了/ }),
    ).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no issues', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());

    renderHygienePanel();

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
  });

  it('calls onSelectTicket with the clicked ticket id', async () => {
    const user = userEvent.setup();
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-click-me',
        kind: 'stale_epic',
        message: '子チケットはすべて完了していますが、エピックが open のままです',
      }),
    ]));

    const { onSelectTicket } = renderHygienePanel();

    await screen.findByText('完了済みエピック');
    await user.click(
      screen.getByRole('button', {
        name: /子チケットはすべて完了していますが、エピックが open のままです/,
      }),
    );

    expect(onSelectTicket).toHaveBeenCalledWith('bdboard-click-me');
  });

  it('passes projectIds to fetchHygiene when provided', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());

    renderHygienePanel({ projectIds: ['proj-a', 'proj-b'] });

    await screen.findByText('警告はありません');

    expect(fetchHygieneMock).toHaveBeenCalledWith(['proj-a', 'proj-b']);
  });

  it('shows project basename with full path in title attribute for long projectId paths', async () => {
    const fullPath =
      '/private/var/folders/dw/_p3b_71d/T/bdboard-e2e-abc123/fixture-project';
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-path-test',
        kind: 'overdue_defer',
        projectId: fullPath,
        message: 'defer_until を過ぎていますが、まだ deferred のままです',
      }),
    ]));

    const { container } = renderHygienePanel();

    await screen.findByText('期限超過の保留');
    const projectSpan = container.querySelector('.hygiene-issue-project');
    expect(projectSpan).not.toBeNull();
    // 部分一致 (toHaveTextContent) だとフルパスのままでも "fixture-project" を含むので通ってしまう。
    // basename 化そのものを検出するために完全一致で見る。
    expect(projectSpan?.textContent?.trim()).toBe('fixture-project');
    expect(projectSpan).toHaveAttribute('title', fullPath);
  });

  it('renders merged_leftover cleanup commands when cleanup is present', async () => {
    const cleanup = {
      repoRootPath: '/repo',
      worktreePath: '/repo/.claude/worktrees/bdboard-3tw.96',
      branchName: 'bd/bdboard-3tw.96',
    };

    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-3tw.96',
        kind: 'merged_leftover',
        message: 'マージ済みだが worktree が残っています',
        cleanup,
      }),
    ]));

    const { container } = renderHygienePanel();

    expect(await screen.findByText('残骸 worktree')).toBeInTheDocument();
    const cleanupCommand = container.querySelector('.hygiene-cleanup-command');
    expect(cleanupCommand).not.toBeNull();
    expect(cleanupCommand!.textContent).toBe(formatWorktreeCleanupScript(cleanup));
  });

  it('renders orphan_heartbeat_loop cleanup commands without repair buttons', async () => {
    const heartbeatLoop = {
      pid: 54321,
      ticketIds: ['bdboard-64lx', 'bdboard-64lx.1'],
      sessionPid: 11111,
      reason: 'all_closed' as const,
    };
    const killScript = formatHeartbeatLoopKillScript({ pid: heartbeatLoop.pid });

    fetchHygieneMock.mockResolvedValue(
      makeHygieneResponse(
        [
          makeIssue({
            ticketId: 'bdboard-64lx',
            kind: 'orphan_heartbeat_loop',
            message:
              '対象チケットはすべて closed だが bd heartbeat ループ (pid 54321) が残っています',
            heartbeatLoop,
          }),
        ],
        { unknownCount: 0 },
      ),
    );

    const { container } = renderHygienePanel();

    expect(await screen.findByText('残骸 heartbeat ループ')).toBeInTheDocument();
    const cleanupCommand = container.querySelector('.hygiene-cleanup-command');
    expect(cleanupCommand).not.toBeNull();
    expect(cleanupCommand!.textContent).toBe(killScript);
    expect(cleanupCommand!.textContent).toContain('kill 54321');
    expect(cleanupCommand!.textContent).not.toContain('pkill');
    expect(cleanupCommand!.textContent).not.toContain('killall');
    expect(
      screen.getByRole('button', { name: '掃除コマンドをコピー' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /保留を解除|エピックを完了/ }),
    ).not.toBeInTheDocument();
  });

  it('renders two orphan_heartbeat_loop rows when the same ticket has loops with different pids', async () => {
    const heartbeatLoopA = {
      pid: 54321,
      ticketIds: ['bdboard-64lx'],
      reason: 'all_closed' as const,
    };
    const heartbeatLoopB = {
      pid: 54322,
      ticketIds: ['bdboard-64lx'],
      reason: 'all_closed' as const,
    };

    fetchHygieneMock.mockResolvedValue(
      makeHygieneResponse(
        [
          makeIssue({
            ticketId: 'bdboard-64lx',
            kind: 'orphan_heartbeat_loop',
            message: 'loop A',
            heartbeatLoop: heartbeatLoopA,
          }),
          makeIssue({
            ticketId: 'bdboard-64lx',
            kind: 'orphan_heartbeat_loop',
            message: 'loop B',
            heartbeatLoop: heartbeatLoopB,
          }),
        ],
        { unknownCount: 0 },
      ),
    );

    const { container } = renderHygienePanel();

    await screen.findByText('loop A');
    expect(container.querySelectorAll('.hygiene-cleanup-command')).toHaveLength(2);
    expect(screen.getByText(formatHeartbeatLoopKillScript({ pid: 54321 }))).toBeInTheDocument();
    expect(screen.getByText(formatHeartbeatLoopKillScript({ pid: 54322 }))).toBeInTheDocument();
  });

  it('renders an in_flight_file_overlap row with its own kind badge', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-pkr6.10',
        kind: 'in_flight_file_overlap',
        severity: 'info',
        message:
          '着手中の 1 件と同じファイルを編集中: bdboard-pkr6.8: src/domain/hygiene.ts',
        overlaps: [
          { otherTicketId: 'bdboard-pkr6.8', files: ['src/domain/hygiene.ts'] },
        ],
      }),
    ]));

    const { container } = renderHygienePanel();

    expect(await screen.findByText('着手中の重複')).toBeInTheDocument();
    expect(
      screen.getByText(
        '着手中の 1 件と同じファイルを編集中: bdboard-pkr6.8: src/domain/hygiene.ts',
      ),
    ).toBeInTheDocument();
    expect(
      container.querySelector('.hygiene-kind-in_flight_file_overlap'),
    ).not.toBeNull();
  });

  it('renders one row for a ticket that overlaps with two others', async () => {
    // 1 チケット複数相手でも行は 1 本。ペアごとに行を出していた頃は
    // React の key (kind + ticketId) が重複していた。
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-pkr6.10',
        kind: 'in_flight_file_overlap',
        severity: 'info',
        message:
          '着手中の 2 件と同じファイルを編集中: bdboard-pkr6.3: src/main.ts; bdboard-pkr6.9: src/interface/http/routes.ts',
        overlaps: [
          { otherTicketId: 'bdboard-pkr6.3', files: ['src/main.ts'] },
          {
            otherTicketId: 'bdboard-pkr6.9',
            files: ['src/interface/http/routes.ts'],
          },
        ],
      }),
    ]));

    const { container } = renderHygienePanel();

    expect(
      await screen.findByText(
        '着手中の 2 件と同じファイルを編集中: bdboard-pkr6.3: src/main.ts; bdboard-pkr6.9: src/interface/http/routes.ts',
      ),
    ).toBeInTheDocument();
    expect(
      container.querySelectorAll('.hygiene-kind-in_flight_file_overlap'),
    ).toHaveLength(1);
  });

  it('copies cleanup commands and shows success feedback', async () => {
    const user = userEvent.setup();
    const cleanup = {
      repoRootPath: '/repo',
      worktreePath: '/repo/.claude/worktrees/bdboard-3tw.96',
      branchName: 'bd/bdboard-3tw.96',
    };
    const cleanupScript = formatWorktreeCleanupScript(cleanup);

    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-3tw.96',
        kind: 'merged_leftover',
        message: 'マージ済みだが worktree が残っています',
        cleanup,
      }),
    ]));

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

    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
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
    ]));

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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'defer_until を過ぎていますが、まだ deferred のままです',
      }),
    ]));

    renderHygienePanel();

    await screen.findByText('期限超過の保留');
    expect(screen.queryByRole('button', { name: '掃除コマンドをコピー' })).not.toBeInTheDocument();
  });

  it('still calls onSelectTicket when a merged_leftover row is clicked', async () => {
    const user = userEvent.setup();
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
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
    ]));

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

    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
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
    ]));

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

    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
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
    ]));

    renderHygienePanel();

    await screen.findByText('循環依存');
    await user.click(screen.getByRole('button', { name: '解消コマンドをコピー' }));

    expect(copyTextToClipboardMock).toHaveBeenCalledWith(removalScript);
    expect(await screen.findByText('掃除コマンドをコピーしました')).toBeInTheDocument();
  });

  it('includes -C in dependency_cycle removal commands when projectRootPaths is provided', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
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
    ]));

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
