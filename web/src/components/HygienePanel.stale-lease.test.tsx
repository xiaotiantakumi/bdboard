// bdboard-sso1.85: HygienePanel.test.tsx (2453行) から move-only で分割した
// 「stale lease（heartbeat 途絶）表示」関心のファイル。関数本体・アサーション・
// フィクスチャの値は元ファイルから1文字も変えていない。
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import {
  makeHygieneResponse,
  makeLeaseHealth,
  renderHygienePanel,
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

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchHygiene: vi.fn(),
    fetchLeaseHealth: vi.fn(),
    fetchMergeSlotStatus: vi.fn(),
    fetchAllHarnessStatus: vi.fn(),
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
} from '../api';

const fetchHygieneMock = vi.mocked(fetchHygiene);
const fetchLeaseHealthMock = vi.mocked(fetchLeaseHealth);
const fetchMergeSlotStatusMock = vi.mocked(fetchMergeSlotStatus);
const fetchAllHarnessStatusMock = vi.mocked(fetchAllHarnessStatus);

describe('HygienePanel stale lease display', () => {
  beforeEach(() => {
    fetchHygieneMock.mockReset();
    fetchLeaseHealthMock.mockReset();
    fetchMergeSlotStatusMock.mockReset();
    fetchAllHarnessStatusMock.mockReset();
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());
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

  it('shows a lease-read-failed skip when no stale lease was found', async () => {
    const reason = 'skipped: bd の in_progress 一覧を読めませんでした';
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth({
      reclaim: {
        enabled: true,
        intervalMs: 300_000,
        olderThan: '10m',
        projects: [{
          projectId: 'proj-a',
          lastRunAt: '2026-08-16T02:55:00.000Z',
          reclaimedCount: null,
          reclaimedCountUnknown: true,
          rawSummary: reason,
          lastError: null,
        }],
      },
    }));

    renderHygienePanel();

    const status = await screen.findByLabelText('自動 reclaim 状況');
    expect(screen.queryByText('警告はありません')).not.toBeInTheDocument();
    expect(status).toHaveTextContent('proj-a: 最終実行 11:55 / 回収件数不明');
    expect(status).toHaveTextContent(reason);
    // 単独で出るときは何の欄か読めるよう種別バッジを付け、group として名前を持たせる。
    expect(screen.getByText('自動 reclaim')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '自動 reclaim 状況' })).toBe(status);
  });

  it('shows a reclaim error when no stale lease was found', async () => {
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth({
      reclaim: {
        enabled: true,
        intervalMs: 300_000,
        olderThan: '10m',
        projects: [{
          projectId: 'proj-a',
          lastRunAt: '2026-08-16T02:55:00.000Z',
          reclaimedCount: 0,
          reclaimedCountUnknown: false,
          rawSummary: null,
          lastError: 'bd reclaim failed',
        }],
      },
    }));

    renderHygienePanel();

    expect(await screen.findByLabelText('自動 reclaim 状況')).toHaveTextContent(
      'エラー: bd reclaim failed',
    );
  });

  it('shows only problem reclaim projects when no stale lease was found', async () => {
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth({
      reclaim: {
        enabled: true,
        intervalMs: 300_000,
        olderThan: '10m',
        projects: [
          {
            projectId: 'proj-problem', lastRunAt: '2026-08-16T02:55:00.000Z', reclaimedCount: 0,
            reclaimedCountUnknown: false, rawSummary: null, lastError: 'bd reclaim failed',
          },
          {
            projectId: 'proj-normal', lastRunAt: '2026-08-16T02:55:00.000Z', reclaimedCount: 0,
            reclaimedCountUnknown: false, rawSummary: 'reclaimed 0 issues', lastError: null,
          },
        ],
      },
    }));

    renderHygienePanel();

    const status = await screen.findByLabelText('自動 reclaim 状況');
    expect(status).toHaveTextContent('proj-problem');
    expect(status).not.toHaveTextContent('proj-normal');
  });

  it('keeps the empty state when all reclaim projects are normal', async () => {
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth({
      reclaim: {
        enabled: true,
        intervalMs: 300_000,
        olderThan: '10m',
        projects: [{
          projectId: 'proj-a', lastRunAt: null, reclaimedCount: 0,
          reclaimedCountUnknown: false, rawSummary: null, lastError: null,
        }],
      },
    }));

    renderHygienePanel();

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
    expect(screen.queryByLabelText('自動 reclaim 状況')).toBeNull();
  });

  it('keeps the empty state when reclaim is disabled despite problem statuses', async () => {
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth({
      reclaim: {
        enabled: false,
        intervalMs: 300_000,
        olderThan: '10m',
        projects: [{
          projectId: 'proj-a', lastRunAt: null, reclaimedCount: null,
          reclaimedCountUnknown: true, rawSummary: 'skipped: bd の in_progress 一覧を読めませんでした',
          lastError: 'bd reclaim failed',
        }],
      },
    }));

    renderHygienePanel();

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
    expect(screen.queryByLabelText('自動 reclaim 状況')).toBeNull();
  });

  it('keeps the empty state when only an excluded project has a reclaim problem', async () => {
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth({
      reclaim: {
        enabled: true,
        intervalMs: 300_000,
        olderThan: '10m',
        projects: [{
          projectId: 'proj-excluded', lastRunAt: null, reclaimedCount: null,
          reclaimedCountUnknown: true, rawSummary: 'skipped: bd の in_progress 一覧を読めませんでした',
          lastError: null,
        }],
      },
    }));

    renderHygienePanel({ projectIds: ['proj-included'] });

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
    expect(screen.queryByLabelText('自動 reclaim 状況')).toBeNull();
  });

  it('renders the reclaim status once inside the stale lease group when both exist', async () => {
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth({
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
            projectId: 'proj-a', lastRunAt: '2026-08-16T02:55:00.000Z', reclaimedCount: null,
            reclaimedCountUnknown: true, rawSummary: 'skipped: bd の in_progress 一覧を読めませんでした',
            lastError: null,
          },
          {
            projectId: 'proj-b', lastRunAt: '2026-08-16T02:55:00.000Z', reclaimedCount: 0,
            reclaimedCountUnknown: false, rawSummary: null, lastError: null,
          },
        ],
      },
    }));

    renderHygienePanel();

    expect(await screen.findByText('stale lease（heartbeat 途絶）')).toBeInTheDocument();
    const statuses = screen.getAllByLabelText('自動 reclaim 状況');
    expect(statuses).toHaveLength(1);
    // stale lease があるときは従来どおり正常なプロジェクトも並べ、単独欄のバッジは出さない。
    expect(statuses[0]).toHaveTextContent('proj-b');
    expect(screen.queryByText('自動 reclaim')).not.toBeInTheDocument();
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
    // 成功時も rawSummary (bd reclaim の出力要約) を件数の後ろに続ける。
    expect(screen.getByLabelText('自動 reclaim 状況').textContent?.trim()).toBe(
      'proj-a: 最終実行 11:55 / 回収 1件 / reclaimed 1 issue',
    );
  });

  // 文言は src/application/lease/reclaim-scheduler.ts の describeReclaimSkip のコピー
  // (web はサーバーのコードを import できない)。理由→文言の対応自体はサーバー側の
  // テストが固定しており、ここで守るのは「件数の後ろに ' / ' で続けて見える」こと。
  it.each([
    'skipped: bd の in_progress 一覧を読めませんでした',
    'skipped: git の worktree / bd ブランチ一覧を最後まで読めず、生存証拠を判定できませんでした',
    'skipped: git worktree を走査できず、生存証拠を判定できませんでした',
  ])('shows the reclaim skip reason next to the unknown count: %s', async (reason) => {
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
              reclaimedCount: null,
              reclaimedCountUnknown: true,
              rawSummary: reason,
              lastError: null,
            },
          ],
        },
      }),
    );

    renderHygienePanel();

    expect(await screen.findByText('stale lease（heartbeat 途絶）')).toBeInTheDocument();
    expect(screen.getByLabelText('自動 reclaim 状況')).toHaveTextContent(
      `proj-a: 最終実行 11:55 / 回収件数不明 / ${reason}`,
    );
  });

  it.each([null, '', '   '])(
    'does not append a reclaim summary separator when rawSummary is %j',
    async (rawSummary) => {
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
              rawSummary,
              lastError: null,
            },
          ],
        },
      }),
    );

    renderHygienePanel();

    expect(await screen.findByText('stale lease（heartbeat 途絶）')).toBeInTheDocument();
    const status = screen.getByLabelText('自動 reclaim 状況');
    expect(status.textContent?.trim()).toBe('proj-a: 最終実行 11:55 / 回収 1件');
    expect(status.querySelector('.hygiene-reclaim-status-summary')).toBeNull();
    },
  );

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
