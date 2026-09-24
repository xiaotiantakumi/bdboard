// bdboard-sso1.85: HygienePanel.test.tsx (2453行) から move-only で分割した
// 「マージスロット表示」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。
import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergeSlotStatusDto } from '../api';
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

describe('HygienePanel merge slot display', () => {
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
