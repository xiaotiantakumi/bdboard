// bdboard-sso1.85: HygienePanel.test.tsx (2453行) から move-only で分割した
// 「非チケット harness worktree 表示」関心のファイル。関数本体・アサーション・
// フィクスチャの値は元ファイルから1文字も変えていない。
import { screen } from '@testing-library/react';
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

describe('HygienePanel non-ticket harness worktree display', () => {
  beforeEach(() => {
    fetchHygieneMock.mockReset();
    fetchLeaseHealthMock.mockReset();
    fetchMergeSlotStatusMock.mockReset();
    fetchAllHarnessStatusMock.mockReset();
    fetchLeaseHealthMock.mockResolvedValue(makeLeaseHealth());
    fetchMergeSlotStatusMock.mockResolvedValue([]);
    fetchAllHarnessStatusMock.mockResolvedValue({ projects: [] });
  });

  it('renders non-ticket (feature/*) harness worktrees separately from stale_harness_worktree issues', async () => {
    fetchHygieneMock.mockResolvedValue(
      makeHygieneResponse([], null, [
        {
          projectId: 'proj-a',
          worktreePath: '/repo/.claude/worktrees/mac-slow-diagnosis-7ddee1',
          branchName: 'feature/mac-slow-diagnosis-7ddee1',
          commitsBehind: 63,
          baseRef: 'origin/main',
          message:
            'この worktree (ブランチ feature/mac-slow-diagnosis-7ddee1) のハーネスは origin/main より 63 コミットぶん古いままです。',
        },
      ]),
    );

    renderHygienePanel();

    expect(await screen.findByText('ハーネス凍結（非チケット）')).toBeInTheDocument();
    expect(screen.getByText('proj-a')).toBeInTheDocument();
    expect(screen.getByText('feature/mac-slow-diagnosis-7ddee1')).toBeInTheDocument();
    expect(
      screen.getByText(
        'この worktree (ブランチ feature/mac-slow-diagnosis-7ddee1) のハーネスは origin/main より 63 コミットぶん古いままです。',
      ),
    ).toBeInTheDocument();
  });

  it('does not render a non-ticket harness worktree section when there are none', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse());

    renderHygienePanel();

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
    expect(screen.queryByText('ハーネス凍結（非チケット）')).not.toBeInTheDocument();
  });
});
