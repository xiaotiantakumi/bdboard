// bdboard-sso1.85: HygienePanel.test.tsx (2453行) から move-only で分割した
// 「close 証拠なし注記」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。
import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import {
  makeHygieneResponse,
  makeIssue,
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

describe('HygienePanel close evidence note', () => {
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

  it('shows close evidence note when unknownCount is greater than zero', async () => {
    fetchHygieneMock.mockResolvedValue(
      makeHygieneResponse(
        [
          makeIssue({
            ticketId: 'bdboard-closed-a',
            kind: 'closed_without_evidence',
            severity: 'info',
            message: 'close 済みだが PR/検証の記録がない',
          }),
          makeIssue({
            ticketId: 'bdboard-closed-b',
            kind: 'closed_without_evidence',
            severity: 'info',
            message: 'close 済みだが PR/検証の記録がない',
          }),
        ],
        { unknownCount: 5 },
      ),
    );

    renderHygienePanel();

    expect(
      await screen.findByText(/close 証拠なし: 2件（5件は未確認）/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/未確認のぶんは判定を見送っています（時間をおくと確定します）/),
    ).toBeInTheDocument();
  });

  it('shows close evidence note even when there are no other hygiene issues', async () => {
    fetchHygieneMock.mockResolvedValue(
      makeHygieneResponse([], { unknownCount: 3 }),
    );

    renderHygienePanel();

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
    expect(
      screen.getByText(/close 証拠なし: 0件（3件は未確認）/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/未確認のぶんは判定を見送っています（時間をおくと確定します）/),
    ).toBeInTheDocument();
  });

  it('does not show close evidence note when closeEvidence is null', async () => {
    fetchHygieneMock.mockResolvedValue(makeHygieneResponse([], null));

    renderHygienePanel();

    expect(await screen.findByText('警告はありません')).toBeInTheDocument();
    expect(screen.queryByText(/close 証拠なし: \d+件（\d+件は未確認）/)).not.toBeInTheDocument();
  });

  it('does not show close evidence note when unknownCount is zero', async () => {
    fetchHygieneMock.mockResolvedValue(
      makeHygieneResponse(
        [
          makeIssue({
            ticketId: 'bdboard-closed',
            kind: 'closed_without_evidence',
            severity: 'info',
            message: 'close 済みだが PR/検証の記録がない',
          }),
        ],
        { unknownCount: 0 },
      ),
    );

    renderHygienePanel();

    expect(await screen.findByText('close 証拠なし')).toBeInTheDocument();
    expect(screen.queryByText(/件は未確認/)).not.toBeInTheDocument();
  });
});
