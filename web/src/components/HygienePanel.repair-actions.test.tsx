// bdboard-sso1.85: HygienePanel.test.tsx (2453行) から move-only で分割した
// 「修復アクション(quick action / ハーネス更新 / hook / 検証コントラクト)」関心の
// ファイル。関数本体・アサーション・フィクスチャの値は元ファイルから1文字も変えていない。
import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import {
  CONFLICT_WRITE_HELP,
  TUNNEL_WRITE_HELP,
} from '../writeAccessMessage';
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

/** HygienePanel.tsx の REPAIR_FEEDBACK_MS と同じ値。 */
const REPAIR_FEEDBACK_MS = 4000;

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchHygiene: vi.fn(),
    fetchLeaseHealth: vi.fn(),
    fetchMergeSlotStatus: vi.fn(),
    fetchAllHarnessStatus: vi.fn(),
    postProjectHarnessInject: vi.fn(),
    postProjectHarnessContractTicket: vi.fn(),
    postTicketQuickAction: vi.fn(),
    postTicketQuickActionUndo: vi.fn(),
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
  postProjectHarnessContractTicket,
  postProjectHarnessInject,
  postTicketQuickAction,
  postTicketQuickActionUndo,
} from '../api';

const fetchHygieneMock = vi.mocked(fetchHygiene);
const fetchLeaseHealthMock = vi.mocked(fetchLeaseHealth);
const fetchMergeSlotStatusMock = vi.mocked(fetchMergeSlotStatus);
const fetchAllHarnessStatusMock = vi.mocked(fetchAllHarnessStatus);
const postProjectHarnessInjectMock = vi.mocked(postProjectHarnessInject);
const postProjectHarnessContractTicketMock = vi.mocked(
  postProjectHarnessContractTicket,
);
const postTicketQuickActionMock = vi.mocked(postTicketQuickAction);
const postTicketQuickActionUndoMock = vi.mocked(postTicketQuickActionUndo);

const NOT_APPLICABLE_CONTRACT = { state: 'not-applicable' } as const;

describe('HygienePanel repair actions', () => {
  let user: ReturnType<typeof userEvent.setup>;

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
    postTicketQuickActionMock.mockReset();
    postTicketQuickActionUndoMock.mockReset();
    showUndoMock.mockReset();
    postTicketQuickActionMock.mockResolvedValue(undefined);
    postTicketQuickActionUndoMock.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  it('shows repair buttons only for repairable kinds', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
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
    ]));

    renderHygienePanel();

    expect(await screen.findByRole('button', { name: '保留を解除' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'エピックを完了' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '掃除コマンドをコピー' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /保留を解除|エピックを完了/ })).toHaveLength(2);
  });

  it('requires confirmation before posting undefer quick action', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
        deferUntil: '2026-08-01',
      }),
    ]));

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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
      }),
    ]));

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

    fetchHygieneMock
      .mockResolvedValueOnce(makeHygieneResponse([overdueIssue]))
      .mockResolvedValue(makeHygieneResponse());

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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
        deferUntil: '2026-08-01',
      }),
    ]));

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

    fetchHygieneMock
      .mockResolvedValueOnce(makeHygieneResponse([overdueIssue]))
      .mockResolvedValue(makeHygieneResponse());

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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
        deferUntil: '2026-08-01',
      }),
    ]));

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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
      makeIssue({
        ticketId: 'bdboard-overdue',
        kind: 'overdue_defer',
        message: 'overdue defer',
      }),
    ]));

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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([
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
    ]));

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

  it('closes stale epic and shows header success message when row disappears', async () => {
    const epicIssue = makeIssue({
      ticketId: 'bdboard-epic',
      kind: 'stale_epic',
      message: 'stale epic',
    });

    fetchHygieneMock
      .mockResolvedValueOnce(makeHygieneResponse([epicIssue]))
      .mockResolvedValue(makeHygieneResponse());

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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.1.0',
              drift: true,
              hooksState: 'none-declared',
              missingHooks: [],
            },
          ],
        },
      ],
    });
    postProjectHarnessInjectMock.mockResolvedValue({
      contract: NOT_APPLICABLE_CONTRACT,
      packs: [],
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

  function makeDriftPack(name: string, availableVersion = '0.2.0') {
    return {
      name,
      availableVersion,
      installedVersion: '0.1.0',
      drift: true,
      hooksState: 'none-declared' as const,
      missingHooks: [] as string[],
    };
  }

  function makeCurrentPack(name: string, version = '0.2.0') {
    return {
      name,
      availableVersion: version,
      installedVersion: version,
      drift: false,
      hooksState: 'none-declared' as const,
      missingHooks: [] as string[],
    };
  }

  it('hides bulk update when other warnings exist but nothing needs an update', async () => {
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [{
        projectId: '/tmp/proj-a',
        contract: NOT_APPLICABLE_CONTRACT,
        packs: [{
          ...makeCurrentPack('bdboard-harness'),
          hooksState: 'missing' as const,
          missingHooks: ['bash "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/pre-bash-guard.sh"'],
        }],
      }],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    // 警告リスト自体は出ている (空振りでない) 状態で、ボタンだけが無いことを見る。
    expect((await screen.findAllByText('hook 未登録')).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: /件をまとめて更新/ }),
    ).not.toBeInTheDocument();
  });

  it('lists a snapshot in the confirmation and writes nothing when cancelled', async () => {
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [{
        projectId: '/tmp/proj-a',
        contract: NOT_APPLICABLE_CONTRACT,
        packs: [makeDriftPack('bdboard-harness')],
      }],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });
    await user.click(await screen.findByRole('button', { name: '要更新 1 件をまとめて更新' }));

    const confirm = screen.getByRole('group', { name: 'ハーネス一括更新の確認' });
    expect(confirm).toHaveTextContent('proj-a / bdboard-harness: v0.1.0 → v0.2.0');
    expect(within(confirm).getByRole('button', { name: '確定: まとめて更新' })).toHaveFocus();

    await user.click(within(confirm).getByRole('button', { name: 'キャンセル' }));
    expect(
      screen.queryByRole('group', { name: 'ハーネス一括更新の確認' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '要更新 1 件をまとめて更新' }));
    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('group', { name: 'ハーネス一括更新の確認' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '要更新 1 件をまとめて更新' })).toBeInTheDocument();
    expect(postProjectHarnessInjectMock).not.toHaveBeenCalled();
  });

  it('continues after a failure, shows each result with the reason, and allows a retry', async () => {
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        { projectId: '/tmp/proj-a', contract: NOT_APPLICABLE_CONTRACT, packs: [makeDriftPack('pack-a')] },
        { projectId: '/tmp/proj-b', contract: NOT_APPLICABLE_CONTRACT, packs: [makeDriftPack('pack-b', '0.3.0')] },
      ],
    });
    postProjectHarnessInjectMock
      .mockRejectedValueOnce(
        new ApiError(500, 'injection failed', {
          errorMessage: 'injection failed',
          detail: 'disk full',
        }),
      )
      .mockResolvedValue({ contract: NOT_APPLICABLE_CONTRACT, packs: [] });

    const { container } = renderHygienePanel({ projectIds: ['/tmp/proj-a', '/tmp/proj-b'] });
    await user.click(await screen.findByRole('button', { name: '要更新 2 件をまとめて更新' }));
    await user.click(screen.getByRole('button', { name: '確定: まとめて更新' }));

    const result = await screen.findByRole('group', { name: 'ハーネス一括更新の結果' });
    expect(postProjectHarnessInjectMock).toHaveBeenNthCalledWith(1, '/tmp/proj-a', 'pack-a');
    expect(postProjectHarnessInjectMock).toHaveBeenNthCalledWith(2, '/tmp/proj-b', 'pack-b');
    expect(within(result).getByText('まとめて更新: 成功 1 件・失敗 1 件')).toBeInTheDocument();
    expect(
      within(result).getByText('proj-a / pack-a: 失敗 (injection failed: disk full)'),
    ).toBeInTheDocument();
    expect(within(result).getByText('proj-b / pack-b: 成功')).toBeInTheDocument();
    expect(container.querySelector('.hygiene-panel-repair-status')).toHaveTextContent(
      'まとめて更新: 成功 1 件・失敗 1 件',
    );
    // 要更新が残っている (再取得も drift のまま) ので、結果を出したまま再試行できる。
    expect(screen.getByRole('button', { name: '要更新 2 件をまとめて更新' })).toBeEnabled();

    // 単体更新で直したら、古い一括結果は消える。
    await user.click(screen.getAllByRole('button', { name: 'ハーネスを更新' })[0]);
    await user.click(screen.getByRole('button', { name: '確定: ハーネスを更新' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('group', { name: 'ハーネス一括更新の結果' }),
      ).not.toBeInTheDocument();
    });
  });

  it('keeps the result visible after a full success clears every warning', async () => {
    fetchAllHarnessStatusMock
      .mockResolvedValueOnce({
        projects: [{
          projectId: '/tmp/proj-a',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [makeDriftPack('bdboard-harness')],
        }],
      })
      .mockResolvedValue({
        projects: [{
          projectId: '/tmp/proj-a',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [makeCurrentPack('bdboard-harness')],
        }],
      });
    postProjectHarnessInjectMock.mockResolvedValue({
      contract: NOT_APPLICABLE_CONTRACT,
      packs: [makeCurrentPack('bdboard-harness')],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });
    await user.click(await screen.findByRole('button', { name: '要更新 1 件をまとめて更新' }));
    await user.click(screen.getByRole('button', { name: '確定: まとめて更新' }));

    const result = await screen.findByRole('group', { name: 'ハーネス一括更新の結果' });
    expect(within(result).getByText('proj-a / bdboard-harness: 成功')).toBeInTheDocument();
    // 再取得で要更新が 0 件 (= 他の警告も 0 件) になっていても結果は残る。
    expect(screen.queryByText('ハーネス要更新')).not.toBeInTheDocument();
    expect(screen.queryByText('警告はありません')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /件をまとめて更新/ }),
    ).not.toBeInTheDocument();

    await user.click(within(result).getByRole('button', { name: '結果を閉じる' }));
    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
  });

  it('disables the per-row update while a bulk update is running', async () => {
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [{
        projectId: '/tmp/proj-a',
        contract: NOT_APPLICABLE_CONTRACT,
        packs: [makeDriftPack('bdboard-harness')],
      }],
    });
    let resolveInject: () => void = () => {};
    postProjectHarnessInjectMock.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<typeof postProjectHarnessInject>>>((resolve) => {
          resolveInject = () => resolve({ contract: NOT_APPLICABLE_CONTRACT, packs: [] });
        }),
    );

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });
    await user.click(await screen.findByRole('button', { name: '要更新 1 件をまとめて更新' }));
    await user.click(screen.getByRole('button', { name: '確定: まとめて更新' }));

    expect(await screen.findByRole('button', { name: '更新中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ハーネスを更新' })).toBeDisabled();

    await act(async () => {
      resolveInject();
    });
    expect(
      await screen.findByRole('group', { name: 'ハーネス一括更新の結果' }),
    ).toBeInTheDocument();
  });

  it('shows a hook 未登録 row and re-injects to fix it', async () => {
    const user = userEvent.setup();
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.2.0',
              drift: false,
              hooksState: 'missing',
              missingHooks: [
                'bash "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/pre-bash-guard.sh"',
                'bash "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/stop-ticket-gate.sh"',
              ],
            },
          ],
        },
      ],
    });
    postProjectHarnessInjectMock.mockResolvedValue({
      contract: NOT_APPLICABLE_CONTRACT,
      packs: [
        {
          name: 'bdboard-harness',
          availableVersion: '0.2.0',
          installedVersion: '0.2.0',
          drift: false,
          hooksState: 'ok',
          missingHooks: [],
        },
      ],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(await screen.findByText('hook 未登録')).toBeInTheDocument();
    expect(
      screen.getByText(
        'bdboard-harness: hook 2 件が .claude/settings.json に未登録です (再注入で解消)',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'hook を登録' }));
    await user.click(screen.getByRole('button', { name: '確定: hook を登録' }));

    await waitFor(() => {
      expect(postProjectHarnessInjectMock).toHaveBeenCalledWith(
        '/tmp/proj-a',
        'bdboard-harness',
      );
    });
  });

  it('does not warn about hooks for a pack that is not installed yet', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: null,
              drift: false,
              hooksState: 'missing',
              missingHooks: ['bash "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/a.sh"'],
            },
          ],
        },
      ],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
    expect(screen.queryByText('hook 未登録')).toBeNull();
  });

  it('shows empty message only when hygiene and harness drift are both clear', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.2.0',
              drift: false,
              hooksState: 'none-declared',
              missingHooks: [],
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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.1.0',
              drift: true,
              hooksState: 'none-declared',
              missingHooks: [],
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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.1.0',
              drift: true,
              hooksState: 'none-declared',
              missingHooks: [],
            },
          ],
        },
        {
          projectId: '/tmp/proj-b',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [
            {
              name: 'other-pack',
              availableVersion: '0.3.0',
              installedVersion: '0.1.0',
              drift: true,
              hooksState: 'none-declared',
              missingHooks: [],
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
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.1.0',
              drift: true,
              hooksState: 'none-declared',
              missingHooks: [],
            },
          ],
        },
        {
          projectId: '/tmp/proj-b',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [
            {
              name: 'other-pack',
              availableVersion: '0.3.0',
              installedVersion: '0.1.0',
              drift: true,
              hooksState: 'none-declared',
              missingHooks: [],
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
  it('shows 検証ループ未定義 for an injected project with no contract file', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: { state: 'missing' },
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.2.0',
              drift: false,
              hooksState: 'none-declared',
              missingHooks: [],
            },
          ],
        },
      ],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(await screen.findByText('検証コントラクト')).toBeInTheDocument();
    expect(screen.getByText('検証ループ未定義')).toBeInTheDocument();
    expect(
      screen.getByText(/\.claude\/bdboard-harness\.json/),
    ).toBeInTheDocument();
  });

  it('spells out an invalid contract and a missing npm script', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: { state: 'invalid', message: 'prFlow は pr / direct / none のいずれかである必要があります' },
          packs: [],
        },
        {
          projectId: '/tmp/proj-b',
          contract: { state: 'command-missing', script: 'verify', verify: 'npm run verify' },
          packs: [],
        },
      ],
    });

    renderHygienePanel({ projectIds: [] });

    expect(await screen.findByText('検証コントラクト不正')).toBeInTheDocument();
    expect(screen.getByText('検証コマンド未定義')).toBeInTheDocument();
    expect(
      screen.getByText(/npm script verify が無い/),
    ).toBeInTheDocument();
  });

  it('does not warn about the contract for uninjected projects', async () => {
    // 未注入 9 プロジェクトが一斉に警告になるのを避ける (bdboard-pkr6.3)。
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: NOT_APPLICABLE_CONTRACT,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: null,
              drift: false,
              hooksState: 'none-declared',
              missingHooks: [],
            },
          ],
        },
      ],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
    expect(screen.queryByText('検証コントラクト')).not.toBeInTheDocument();
  });

  it('files a harness-contract ticket for a broken contract and shows the created-ticket feedback', async () => {
    const user = userEvent.setup();
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: { state: 'missing' },
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.2.0',
              drift: false,
              hooksState: 'none-declared',
              missingHooks: [],
            },
          ],
        },
      ],
    });
    postProjectHarnessContractTicketMock.mockResolvedValue({
      ticketId: 'proj-a-42',
      created: true,
      stateAppend: 'not-needed',
      contract: { state: 'missing' },
    });

    const { container } = renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(await screen.findByText('検証ループ未定義')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'チケットを起票' }));
    await user.click(screen.getByRole('button', { name: '確定: チケットを起票' }));

    await waitFor(() => {
      expect(postProjectHarnessContractTicketMock).toHaveBeenCalledWith(
        '/tmp/proj-a',
      );
    });

    const repairStatus = container.querySelector('.hygiene-panel-repair-status');
    expect(repairStatus).toHaveTextContent('チケットを起票しました: proj-a-42');
  });

  it('shows the idempotent (existing-ticket) message, not a "created" message, when the label already had an open ticket', async () => {
    const user = userEvent.setup();
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        { projectId: '/tmp/proj-a', contract: { state: 'invalid', message: 'bad json' }, packs: [] },
      ],
    });
    postProjectHarnessContractTicketMock.mockResolvedValue({
      ticketId: 'proj-a-7',
      created: false,
      stateAppend: 'not-needed',
      contract: { state: 'invalid', message: 'bad json' },
    });

    const { container } = renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(await screen.findByText('検証コントラクト不正')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'チケットを起票' }));
    await user.click(screen.getByRole('button', { name: '確定: チケットを起票' }));

    const repairStatus = await waitFor(() => {
      const el = container.querySelector('.hygiene-panel-repair-status');
      expect(el).toHaveTextContent('既存のチケットがあります: proj-a-7');
      return el;
    });
    expect(repairStatus).not.toHaveTextContent('チケットを起票しました');
    expect(repairStatus).not.toHaveTextContent('追記');
  });

  // bdboard-13mp: state 遷移をまたいだ陳腐化チケットの扱い — 既存チケットの記録済み
  // state が現在の state と違って追記されたとき/追記に失敗したときの UI 文言。
  it('shows the state-change-appended message when the server appended a comment to the existing ticket', async () => {
    const user = userEvent.setup();
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        { projectId: '/tmp/proj-a', contract: { state: 'invalid', message: 'bad json' }, packs: [] },
      ],
    });
    // bdboard-13mp レビュー指摘の回帰テスト: サーバーのレスポンスに載る contract
    // (command-missing) を、この行より前にポーリングでキャッシュされていた
    // fetchAllHarnessStatusMock の contract (invalid) とわざと違えてある。
    // メッセージが「検証コマンド未定義」(サーバーのレスポンス由来) になれば
    // vars.result.contract を使っている証拠、「検証コントラクト不正」(キャッシュ由来)
    // のままなら古いキャッシュを使ってしまう回帰。
    postProjectHarnessContractTicketMock.mockResolvedValue({
      ticketId: 'proj-a-7',
      created: false,
      stateAppend: 'appended',
      contract: { state: 'command-missing', script: 'verify', verify: 'npm run verify' },
    });

    const { container } = renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(await screen.findByText('検証コントラクト不正')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'チケットを起票' }));
    await user.click(screen.getByRole('button', { name: '確定: チケットを起票' }));

    const repairStatus = await waitFor(() => {
      const el = container.querySelector('.hygiene-panel-repair-status');
      expect(el).toHaveTextContent(
        '既存のチケットがあります: proj-a-7（現在の状態 検証コマンド未定義 を追記しました）',
      );
      return el;
    });
    expect(repairStatus).not.toHaveTextContent('チケットを起票しました');
    expect(repairStatus).not.toHaveTextContent('検証コントラクト不正');
  });

  it('shows the append-failed (fail-soft) message when the server could not append the state-change comment', async () => {
    const user = userEvent.setup();
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        { projectId: '/tmp/proj-a', contract: { state: 'missing' }, packs: [] },
      ],
    });
    postProjectHarnessContractTicketMock.mockResolvedValue({
      ticketId: 'proj-a-9',
      created: false,
      stateAppend: 'failed',
      contract: { state: 'missing' },
    });

    const { container } = renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    expect(await screen.findByText('検証ループ未定義')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'チケットを起票' }));
    await user.click(screen.getByRole('button', { name: '確定: チケットを起票' }));

    const repairStatus = await waitFor(() => {
      const el = container.querySelector('.hygiene-panel-repair-status');
      expect(el).toHaveTextContent(
        '既存のチケットがあります: proj-a-9（現在の状態の追記に失敗しました。手動でコメントを確認してください）',
      );
      return el;
    });
    // fail-soft: still a "found the ticket" message, not the request-level error banner.
    expect(repairStatus).not.toHaveTextContent('チケットを起票しました');
  });

  it('does not offer a ticket button for an ok contract (nothing to fix)', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
    fetchAllHarnessStatusMock.mockResolvedValue({
      projects: [
        {
          projectId: '/tmp/proj-a',
          contract: {
            state: 'ok',
            verify: 'npm run verify',
            prFlow: 'pr',
            mainBranch: 'main',
            models: null,
            expiredExcludeCount: 1,
            modelExclusionWarnings: [],
          },
          packs: [],
        },
      ],
    });

    renderHygienePanel({ projectIds: ['/tmp/proj-a'] });

    // ok は (期限切れ除外で) 要注意バッジ付きで出るが、直すべきファイル不備が無いので
    // チケット起票ボタンは出ない (harnessContractNeedsTicket が false)。
    expect(await screen.findByText('検証コントラクト')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'チケットを起票' }),
    ).not.toBeInTheDocument();
  });
});
