import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CfdStatsDto,
  HarnessKpiDto,
  ModelStatsDto,
  ThroughputStatsDto,
} from '../api';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import { ThroughputStats } from './ThroughputStats';
import { formatWeekLabel } from './throughputStatsFormatting';

vi.mock('../api', () => ({
  fetchThroughputStats: vi.fn(),
  fetchCfdStats: vi.fn(),
  fetchModelStats: vi.fn(),
  fetchHarnessKpi: vi.fn(),
}));

import {
  fetchCfdStats,
  fetchHarnessKpi,
  fetchModelStats,
  fetchThroughputStats,
} from '../api';

const fetchThroughputStatsMock = vi.mocked(fetchThroughputStats);
const fetchCfdStatsMock = vi.mocked(fetchCfdStats);
const fetchModelStatsMock = vi.mocked(fetchModelStats);
const fetchHarnessKpiMock = vi.mocked(fetchHarnessKpi);

function makeHarnessKpi(overrides?: Partial<HarnessKpiDto>): HarnessKpiDto {
  return {
    rangeStart: '2026-08-04T15:00:00.000Z',
    rangeEnd: '2026-08-18T15:00:00.000Z',
    pendingDecisionDwell: {
      closedCount: 4,
      closedGateCount: 3,
      closedWorkCount: 1,
      openCount: 2,
      openGateCount: 1,
      openWorkCount: 1,
      medianMs: 2 * 60 * 60_000,
      p90Ms: 30 * 60 * 60_000,
      anchor: 'created',
    },
    reclaim: {
      runCount: 4,
      reclaimedCountTotal: 5,
      unknownCountRunCount: 0,
      identifiedTicketCount: 4,
      reclaimedThenInProgressCount: 1,
      reclaimedThenInProgressRate: 0.25,
      windowMs: 30 * 60_000,
      since: '2026-08-18T00:00:00.000Z',
      unparsedRunCount: 0,
    },
    harnessLabeled: { matchedCount: 3, totalCount: 8, rate: 0.375 },
    duplicateMention: { matchedCount: 2, totalCount: 8, rate: 0.25 },
    ...overrides,
  };
}

function makeCfdStats(overrides?: Partial<CfdStatsDto>): CfdStatsDto {
  return {
    projects: [
      {
        projectId: 'proj-1',
        projectName: 'Project One',
        days: [
          { date: '2026-08-13', counts: { open: 2, blocked: 1 } },
          { date: '2026-08-14', counts: { open: 1, in_progress: 1 } },
        ],
      },
    ],
    totals: [
      { date: '2026-08-13', counts: { open: 2, blocked: 1 } },
      { date: '2026-08-14', counts: { open: 1, in_progress: 1 } },
    ],
    ...overrides,
  };
}

function makeModelStats(overrides?: Partial<ModelStatsDto>): ModelStatsDto {
  return {
    weeklyCloses: [
      {
        weekStart: '2026-08-04T15:00:00.000Z',
        counts: { 'composer-2.5': 2, 'gpt-5': 1 },
      },
      {
        weekStart: '2026-08-11T15:00:00.000Z',
        counts: { 'composer-2.5': 1 },
      },
    ],
    stageModelDistribution: [
      { stage: 'implement', counts: { 'composer-2.5': 2, 'gpt-5': 1 } },
      { stage: 'review', counts: { 'composer-2.5': 1 } },
    ],
    ...overrides,
  };
}

function makeStats(overrides?: Partial<ThroughputStatsDto>): ThroughputStatsDto {
  return {
    projects: [
      {
        projectId: 'proj-1',
        projectName: 'Project One',
        weeklyCloses: [
          { weekStart: '2026-08-04T15:00:00.000Z', count: 2 },
          { weekStart: '2026-08-11T15:00:00.000Z', count: 1 },
        ],
        openTicketAge: {
          d0to1: 1,
          d1to7: 2,
          d7to30: 0,
          d30plus: 0,
        },
      },
    ],
    totals: {
      weeklyCloses: [
        { weekStart: '2026-08-04T15:00:00.000Z', count: 2 },
        { weekStart: '2026-08-11T15:00:00.000Z', count: 1 },
      ],
      openTicketAge: {
        d0to1: 1,
        d1to7: 2,
        d7to30: 0,
        d30plus: 0,
      },
    },
    ...overrides,
  };
}

function renderThroughputStats(
  options?: {
    projectIds?: readonly string[];
    weeks?: 4 | 8 | 12;
    onWeeksChange?: (weeks: 4 | 8 | 12) => void;
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const onWeeksChange = options?.onWeeksChange ?? vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <ThroughputStats
        projectIds={options?.projectIds ?? []}
        weeks={options?.weeks ?? 8}
        onWeeksChange={onWeeksChange}
      />
    </QueryClientProvider>,
  );

  return { onWeeksChange };
}

describe('ThroughputStats', () => {
  beforeEach(() => {
    fetchThroughputStatsMock.mockReset();
    fetchCfdStatsMock.mockReset();
    fetchModelStatsMock.mockReset();
    fetchHarnessKpiMock.mockReset();
    fetchCfdStatsMock.mockResolvedValue(makeCfdStats());
    fetchModelStatsMock.mockResolvedValue(makeModelStats());
    fetchHarnessKpiMock.mockResolvedValue(makeHarnessKpi());
  });

  it('renders the harness KPI panel with all four metrics', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());

    renderThroughputStats();

    const panel = await screen.findByLabelText('ハーネスKPI');
    expect(
      within(panel).getByText('確認待ちのままクローズしたチケットの滞留 (中央値 / p90)'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('2.0時間 / 1.3日')).toBeInTheDocument();
    expect(within(panel).getByText('4回 / 25.0%')).toBeInTheDocument();
    expect(within(panel).getByText('3件 / 8件 (37.5%)')).toBeInTheDocument();
    expect(within(panel).getByText('2件 / 8件 (25.0%)')).toBeInTheDocument();
  });

  it('notes the created-time fallback and that reclaim records are not persisted', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());

    renderThroughputStats();

    const panel = await screen.findByLabelText('ハーネスKPI');
    expect(panel).toHaveTextContent('作成時刻を起点');
    expect(panel).toHaveTextContent('保存されません');
    expect(panel).toHaveTextContent('粗い指標');
    expect(panel).toHaveTextContent('代理指標');
  });

  it('breaks the pending-decision counts down into gate and work tickets', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());

    renderThroughputStats();

    const panel = await screen.findByLabelText('ハーネスKPI');
    expect(panel).toHaveTextContent('クローズ 4件 (gate 3 / 作業 1)');
    expect(panel).toHaveTextContent('未回答 2件 (gate 1 / 作業 1、期間によらず現在値)');
    // 回答時に human ラベルだけ外した作業チケットが母数に入らないことを明記する。
    expect(panel).toHaveTextContent('human ラベルだけを外した作業チケット');
  });

  it('notes reclaim runs that were dropped because the output was unreadable', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());
    fetchHarnessKpiMock.mockResolvedValue(
      makeHarnessKpi({
        reclaim: {
          runCount: 1,
          reclaimedCountTotal: 1,
          unknownCountRunCount: 0,
          identifiedTicketCount: 1,
          reclaimedThenInProgressCount: 0,
          reclaimedThenInProgressRate: 0,
          windowMs: 30 * 60_000,
          since: '2026-08-18T00:00:00.000Z',
          unparsedRunCount: 3,
        },
      }),
    );

    renderThroughputStats();

    const panel = await screen.findByLabelText('ハーネスKPI');
    expect(panel).toHaveTextContent('出力を読めず除外した実行 3回');
  });

  it('degrades only the harness KPI block when its request fails', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());
    fetchHarnessKpiMock.mockRejectedValue(new Error('KPI ダウン'));

    renderThroughputStats();

    const panel = await screen.findByLabelText('ハーネスKPI');
    expect(await within(panel).findByText('KPI ダウン')).toBeInTheDocument();
    // 統計タブの他のブロックは生き残る。
    expect(await screen.findByLabelText('モデル別実績')).toBeInTheDocument();
    expect(screen.getByText('全体')).toBeInTheDocument();
  });

  it('shows a dash instead of a rate when the harness KPI has no samples', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());
    fetchHarnessKpiMock.mockResolvedValue(
      makeHarnessKpi({
        pendingDecisionDwell: {
          closedCount: 0,
          closedGateCount: 0,
          closedWorkCount: 0,
          openCount: 0,
          openGateCount: 0,
          openWorkCount: 0,
          medianMs: null,
          p90Ms: null,
          anchor: 'created',
        },
        reclaim: {
          runCount: 0,
          reclaimedCountTotal: 0,
          unknownCountRunCount: 0,
          identifiedTicketCount: 0,
          reclaimedThenInProgressCount: 0,
          reclaimedThenInProgressRate: null,
          windowMs: 30 * 60_000,
          since: null,
          unparsedRunCount: 0,
        },
        harnessLabeled: { matchedCount: 0, totalCount: 0, rate: null },
        duplicateMention: { matchedCount: 0, totalCount: 0, rate: null },
      }),
    );

    renderThroughputStats();

    const panel = await screen.findByLabelText('ハーネスKPI');
    expect(within(panel).getByText('— / —')).toBeInTheDocument();
    expect(within(panel).getByText('0回 / —')).toBeInTheDocument();
    expect(within(panel).getAllByText('0件 / 0件 (—)')).toHaveLength(2);
  });

  it('shows weekly close counts and age bucket counts', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());

    renderThroughputStats();

    expect(await screen.findByText('全体')).toBeInTheDocument();
    expect(screen.getByText('Project One')).toBeInTheDocument();
    expect(screen.getAllByText('2件').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1件').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0-1日').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1-7日').length).toBeGreaterThan(0);
    expect(screen.getAllByText('7-30日').length).toBeGreaterThan(0);
    expect(screen.getAllByText('30日以上').length).toBeGreaterThan(0);
  });

  it('renders CFD dates and counts when snapshot data exists', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());
    fetchCfdStatsMock.mockResolvedValue(makeCfdStats());

    renderThroughputStats();

    expect((await screen.findAllByText('累積フロー図 (CFD)')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('08/13').length).toBeGreaterThan(0);
    expect(screen.getAllByText('08/14').length).toBeGreaterThan(0);
    expect(screen.getAllByText('未着手').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ブロック中').length).toBeGreaterThan(0);
  });

  it('shows each CFD legend count from the latest snapshot', async () => {
    fetchThroughputStatsMock.mockResolvedValue(
      makeStats({ projects: [] }),
    );
    fetchCfdStatsMock.mockResolvedValue(
      makeCfdStats({
        projects: [],
        totals: [
          { date: '2026-08-13', counts: { open: 2 } },
          { date: '2026-08-14', counts: { open: 7 } },
        ],
      }),
    );

    renderThroughputStats();

    const legend = await screen.findByLabelText('ステータス凡例');
    const [openItem] = within(legend).getAllByRole('listitem');
    expect(openItem).toHaveTextContent('未着手 (最新 7件)');
    expect(openItem).not.toHaveTextContent('最新 2件');
  });

  it('shows CFD empty state when snapshot data is missing', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());
    fetchCfdStatsMock.mockResolvedValue(
      makeCfdStats({
        projects: [
          {
            projectId: 'proj-1',
            projectName: 'Project One',
            days: [],
          },
        ],
        totals: [],
      }),
    );

    renderThroughputStats();

    expect(await screen.findByText('全体')).toBeInTheDocument();
    expect(screen.getAllByText('CFDデータはまだありません').length).toBeGreaterThan(0);
  });

  it('shows an empty state when there is no data', async () => {
    fetchThroughputStatsMock.mockResolvedValue(
      makeStats({
        projects: [
          {
            projectId: 'proj-1',
            projectName: 'Project One',
            weeklyCloses: [{ weekStart: '2026-08-11T15:00:00.000Z', count: 0 }],
            openTicketAge: {
              d0to1: 0,
              d1to7: 0,
              d7to30: 0,
              d30plus: 0,
            },
          },
        ],
        totals: {
          weeklyCloses: [{ weekStart: '2026-08-11T15:00:00.000Z', count: 0 }],
          openTicketAge: {
            d0to1: 0,
            d1to7: 0,
            d7to30: 0,
            d30plus: 0,
          },
        },
      }),
    );
    fetchCfdStatsMock.mockResolvedValue(
      makeCfdStats({
        projects: [
          {
            projectId: 'proj-1',
            projectName: 'Project One',
            days: [],
          },
        ],
        totals: [],
      }),
    );

    renderThroughputStats();

    expect(
      await screen.findByText('この期間の統計データはありません'),
    ).toBeInTheDocument();
  });

  it('shows a loading state while fetching', () => {
    fetchThroughputStatsMock.mockReturnValue(new Promise(() => undefined));
    fetchCfdStatsMock.mockReturnValue(new Promise(() => undefined));

    renderThroughputStats();

    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
  });

  it('shows an error state when fetching fails', async () => {
    fetchThroughputStatsMock.mockRejectedValue(new Error('network failed'));

    renderThroughputStats();

    expect(await screen.findByText('network failed')).toBeInTheDocument();
  });

  it('changes the selected weeks via the toggle', async () => {
    const user = userEvent.setup();
    fetchThroughputStatsMock.mockResolvedValue(makeStats());

    const { onWeeksChange } = renderThroughputStats({ weeks: 8 });

    await screen.findByText('全体');
    await user.click(screen.getByRole('button', { name: '12週' }));

    expect(onWeeksChange).toHaveBeenCalledWith(12);
  });

  it('passes projectIds to fetchThroughputStats when provided', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());

    renderThroughputStats({ projectIds: ['proj-a', 'proj-b'], weeks: 4 });

    await screen.findByText('全体');

    expect(fetchThroughputStatsMock).toHaveBeenCalledWith(4, ['proj-a', 'proj-b']);
    expect(fetchCfdStatsMock).toHaveBeenCalledWith(28, ['proj-a', 'proj-b']);
    expect(fetchModelStatsMock).toHaveBeenCalledWith(4, ['proj-a', 'proj-b']);
  });

  it('renders model stats tables when data exists', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());
    fetchModelStatsMock.mockResolvedValue(makeModelStats());

    renderThroughputStats();

    const weeklyHeading = await screen.findByText('モデル別クローズ件数(週次)');
    const stageHeading = screen.getByText('工程×モデルの分布');

    const weeklyBlock = weeklyHeading.closest('.throughput-chart-block');
    const stageBlock = stageHeading.closest('.throughput-chart-block');
    expect(weeklyBlock).not.toBeNull();
    expect(stageBlock).not.toBeNull();

    const weeklyScope = within(weeklyBlock as HTMLElement);
    const stageScope = within(stageBlock as HTMLElement);

    expect(weeklyScope.getByText('composer-2.5')).toBeInTheDocument();
    expect(weeklyScope.getByText('gpt-5')).toBeInTheDocument();

    expect(stageScope.getByText('composer-2.5')).toBeInTheDocument();
    expect(stageScope.getByText('gpt-5')).toBeInTheDocument();
    expect(stageScope.getByText('implement')).toBeInTheDocument();
    expect(stageScope.getByText('review')).toBeInTheDocument();
  });

  it('shows model stats empty state when there is no model data', async () => {
    fetchThroughputStatsMock.mockResolvedValue(makeStats());
    fetchModelStatsMock.mockResolvedValue(
      makeModelStats({
        weeklyCloses: [{ weekStart: '2026-08-11T15:00:00.000Z', counts: {} }],
        stageModelDistribution: [],
      }),
    );

    renderThroughputStats();

    expect(
      await screen.findByText('モデル別の実績データはまだありません'),
    ).toBeInTheDocument();
  });
});

describe('formatWeekLabel', () => {
  afterEach(() => {
    resetBoardTimeZoneForTests();
  });

  it('formats a week label from the local date of weekStart', () => {
    const weekStart = new Date(2026, 7, 11);
    const year = weekStart.getFullYear();
    const month = String(weekStart.getMonth() + 1).padStart(2, '0');
    const day = String(weekStart.getDate()).padStart(2, '0');

    expect(formatWeekLabel(weekStart.toISOString())).toBe(
      `${year}-${month}-${day}の週`,
    );
  });

  it('uses the board timezone override for week labels', () => {
    setBoardTimeZoneOverride('Asia/Tokyo');
    const weekStartUtc = '2026-08-11T20:00:00.000Z';

    expect(formatWeekLabel(weekStartUtc)).toBe('2026-08-12の週');
  });
});
