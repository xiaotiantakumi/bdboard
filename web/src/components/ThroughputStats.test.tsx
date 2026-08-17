import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CfdStatsDto, ModelStatsDto, ThroughputStatsDto } from '../api';
import { ThroughputStats } from './ThroughputStats';
import { formatWeekLabel } from './throughputStatsFormatting';

vi.mock('../api', () => ({
  fetchThroughputStats: vi.fn(),
  fetchCfdStats: vi.fn(),
  fetchModelStats: vi.fn(),
}));

import { fetchCfdStats, fetchModelStats, fetchThroughputStats } from '../api';

const fetchThroughputStatsMock = vi.mocked(fetchThroughputStats);
const fetchCfdStatsMock = vi.mocked(fetchCfdStats);
const fetchModelStatsMock = vi.mocked(fetchModelStats);

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
    fetchCfdStatsMock.mockResolvedValue(makeCfdStats());
    fetchModelStatsMock.mockResolvedValue(makeModelStats());
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
  it('formats a week label from the local date of weekStart', () => {
    const weekStart = new Date(2026, 7, 11);
    const year = weekStart.getFullYear();
    const month = String(weekStart.getMonth() + 1).padStart(2, '0');
    const day = String(weekStart.getDate()).padStart(2, '0');

    expect(formatWeekLabel(weekStart.toISOString())).toBe(
      `${year}-${month}-${day}の週`,
    );
  });
});
