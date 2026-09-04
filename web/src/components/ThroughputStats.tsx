import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AgeDistributionDto,
  CfdDayEntryDto,
  HarnessKpiDto,
  ModelStatsDto,
  ProjectCfdStatsDto,
  ProjectThroughputStatsDto,
  ThroughputStatsDto,
  WeeklyCloseCountDto,
} from '../api';
import {
  fetchCfdStats,
  fetchHarnessKpi,
  fetchModelStats,
  fetchThroughputStats,
} from '../api';
import {
  STATS_WEEKS,
  statsWeeksLabel,
  type StatsWeeks,
} from '../uiPersistedState';
import { togglePressedProps } from './toggleGroupA11y';
import {
  ageBucketEntries,
  formatDurationMs,
  formatKpiTimestamp,
  formatRatePercent,
  formatShare,
  formatWeekLabel,
  hasAnyOpenTickets,
  hasAnyWeeklyCloses,
} from './throughputStatsFormatting';

export interface ThroughputStatsProps {
  readonly projectIds: readonly string[];
  weeks: StatsWeeks;
  onWeeksChange: (weeks: StatsWeeks) => void;
}

const CFD_STATUS_ORDER = [
  'open',
  'in_progress',
  'blocked',
  'closed',
  'deferred',
  'pinned',
  'hooked',
] as const;

const CFD_STATUS_LABELS: Record<string, string> = {
  open: '未着手',
  in_progress: '作業中',
  blocked: 'ブロック中',
  closed: '完了',
  deferred: '延期',
  pinned: '固定',
  hooked: 'フック',
};

const CFD_STATUS_COLORS: Record<string, string> = {
  open: 'var(--throughput-cfd-open, #60a5fa)',
  in_progress: 'var(--throughput-cfd-in-progress, #34d399)',
  blocked: 'var(--throughput-cfd-blocked, #f87171)',
  closed: 'var(--throughput-cfd-closed, #94a3b8)',
  deferred: 'var(--throughput-cfd-deferred, #fbbf24)',
  pinned: 'var(--throughput-cfd-pinned, #c084fc)',
  hooked: 'var(--throughput-cfd-hooked, #fb7185)',
};

const CHART_DESCRIPTIONS = {
  openTicketAge:
    '未完了チケットが作成から何日経過しているか(件数)',
  modelWeeklyCloses:
    '工程で使用したAIモデルごとの、週次クローズ件数',
  modelStageDistribution:
    '実装/テスト/レビュー等の工程ごとに、どのAIモデルが何件使われたか',
} as const;

const SECTION_DESCRIPTIONS = {
  throughput:
    'チケットの完了ペースと、未完了チケットの滞留状況',
  flow:
    '日々のステータス別件数の推移からボトルネックを読み取る',
  modelStats:
    'bdメタデータ(bdboard.model.<工程>)から集計した、工程ごとのAIモデル使用実績',
  harnessKpi:
    'エージェント作業の進め方(ハーネス)自体が効いているかを見る4指標',
} as const;

function ChartBlockHeader({
  heading,
  description,
  level,
}: {
  heading: string;
  description?: string;
  level: 4 | 5;
}) {
  const Heading = level === 4 ? 'h4' : 'h5';

  return (
    <>
      <Heading className="throughput-chart-heading">{heading}</Heading>
      {description !== undefined && (
        <p className="throughput-chart-description">{description}</p>
      )}
    </>
  );
}

function StatsSection({
  heading,
  description,
  children,
}: {
  heading: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="throughput-stats-section" aria-label={heading}>
      <div className="throughput-stats-section-header">
        <h4 className="throughput-stats-section-heading">{heading}</h4>
        <p className="throughput-stats-section-description">{description}</p>
      </div>
      {children}
    </section>
  );
}

interface WeeklyBarChartProps {
  weeklyCloses: readonly WeeklyCloseCountDto[];
  chartLabel: string;
}

interface AgeBarChartProps {
  distribution: AgeDistributionDto;
  chartLabel: string;
}

interface CfdStackedChartProps {
  days: readonly CfdDayEntryDto[];
  chartLabel: string;
}

function formatCfdDateLabel(date: string): string {
  const [year, month, day] = date.split('-');
  if (year === undefined || month === undefined || day === undefined) {
    return date;
  }
  return `${month}/${day}`;
}

function collectCfdStatuses(days: readonly CfdDayEntryDto[]): readonly string[] {
  const known = new Set<string>(CFD_STATUS_ORDER);
  const extras = new Set<string>();

  for (const day of days) {
    for (const status of Object.keys(day.counts)) {
      if (!known.has(status)) {
        extras.add(status);
      }
    }
  }

  return [...CFD_STATUS_ORDER, ...[...extras].sort()];
}

function dayTotal(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function hasAnyCfdData(days: readonly CfdDayEntryDto[]): boolean {
  return days.some((day) => dayTotal(day.counts) > 0);
}

function CfdStackedChart({ days, chartLabel }: CfdStackedChartProps) {
  if (days.length === 0 || !hasAnyCfdData(days)) {
    return (
      <div className="throughput-chart-block">
        <ChartBlockHeader
          heading="累積フロー図 (CFD)"
          level={5}
        />
        <p className="empty-message">CFDデータはまだありません</p>
      </div>
    );
  }

  const statuses = collectCfdStatuses(days);
  const maxTotal = Math.max(1, ...days.map((day) => dayTotal(day.counts)));
  const chartHeight = 56;
  const barWidth = 100 / Math.max(days.length, 1);
  const latestDay = days[days.length - 1];
  const visibleStatuses = statuses.filter((status) =>
    days.some((day) => (day.counts[status] ?? 0) > 0),
  );

  return (
    <div className="throughput-chart-block">
      <ChartBlockHeader
        heading="累積フロー図 (CFD)"
        level={5}
      />
      <ul className="throughput-cfd-list">
        {days.map((day) => (
          <li key={day.date} className="throughput-cfd-item">
            <span className="throughput-cfd-label">{formatCfdDateLabel(day.date)}</span>
            <span className="throughput-cfd-count">{dayTotal(day.counts)}件</span>
          </li>
        ))}
      </ul>
      {visibleStatuses.length > 0 && (
        <ul className="throughput-cfd-legend throughput-cfd-legend-above-chart" aria-label="ステータス凡例">
          {visibleStatuses.map((status) => {
            const latestCount = latestDay?.counts[status] ?? 0;
            return (
              <li key={status} className="throughput-cfd-legend-item">
                <span
                  className="throughput-cfd-legend-swatch"
                  style={{ background: CFD_STATUS_COLORS[status] ?? '#64748b' }}
                  aria-hidden="true"
                />
                <span>
                  {CFD_STATUS_LABELS[status] ?? status}
                  <span className="throughput-cfd-legend-count">
                    {' '}
                    (最新 {latestCount}件)
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <svg
        className="throughput-cfd-chart"
        viewBox={`0 0 100 ${chartHeight}`}
        width="100%"
        role="img"
        aria-label={chartLabel}
      >
        {days.map((day, dayIndex) => {
          let cumulative = 0;
          const x = dayIndex * barWidth + barWidth * 0.12;
          const width = barWidth * 0.76;

          return statuses.flatMap((status) => {
            const count = day.counts[status] ?? 0;
            if (count <= 0) {
              return [];
            }

            const segmentHeight = (count / maxTotal) * (chartHeight - 8);
            const y = chartHeight - cumulative - segmentHeight;
            cumulative += (count / maxTotal) * (chartHeight - 8);
            const label = `${formatCfdDateLabel(day.date)} ${CFD_STATUS_LABELS[status] ?? status}: ${count}件`;

            return [
              <rect
                key={`${day.date}-${status}`}
                x={x}
                y={y}
                width={width}
                height={segmentHeight}
                className={`throughput-cfd-bar throughput-cfd-bar-${status.replace(/[^a-z0-9_-]/gi, '_')}`}
                style={{ fill: CFD_STATUS_COLORS[status] ?? '#64748b' }}
                aria-hidden="true"
              >
                <title>{label}</title>
              </rect>,
            ];
          });
        })}
      </svg>
    </div>
  );
}

function WeeklyBarChart({ weeklyCloses, chartLabel }: WeeklyBarChartProps) {
  const maxCount = Math.max(1, ...weeklyCloses.map((entry) => entry.count));
  const barWidth = 100 / Math.max(weeklyCloses.length, 1);
  const chartHeight = 48;

  return (
    <div className="throughput-chart-block">
      <ChartBlockHeader
        heading="週次クローズ数"
        level={5}
      />
      <ul className="throughput-week-list">
        {weeklyCloses.map((entry) => (
          <li key={entry.weekStart} className="throughput-week-item">
            <span className="throughput-week-label">
              {formatWeekLabel(entry.weekStart)}
            </span>
            <span className="throughput-week-count">{entry.count}件</span>
          </li>
        ))}
      </ul>
      <svg
        className="throughput-week-chart"
        viewBox={`0 0 100 ${chartHeight}`}
        width="100%"
        role="img"
        aria-label={chartLabel}
      >
        {weeklyCloses.map((entry, index) => {
          const barHeight = (entry.count / maxCount) * (chartHeight - 8);
          const x = index * barWidth + barWidth * 0.15;
          const width = barWidth * 0.7;
          const y = chartHeight - barHeight;
          const label = `${formatWeekLabel(entry.weekStart)}: ${entry.count}件`;

          return (
            <g key={entry.weekStart}>
              <rect
                x={x}
                y={y}
                width={width}
                height={barHeight}
                rx={1.5}
                className="throughput-week-bar"
                aria-hidden="true"
              >
                <title>{label}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function AgeBarChart({ distribution, chartLabel }: AgeBarChartProps) {
  const entries = ageBucketEntries(distribution);
  const maxCount = Math.max(1, ...entries.map((entry) => entry.count));
  const chartWidth = 100;

  return (
    <div className="throughput-chart-block">
      <ChartBlockHeader
        heading="未完了チケットの年齢分布"
        description={CHART_DESCRIPTIONS.openTicketAge}
        level={5}
      />
      <ul className="throughput-age-list">
        {entries.map((entry) => (
          <li key={entry.key} className="throughput-age-item">
            <span className="throughput-age-label">{entry.label}</span>
            <span className="throughput-age-count">{entry.count}件</span>
          </li>
        ))}
      </ul>
      <svg
        className="throughput-age-chart"
        viewBox={`0 0 ${chartWidth} ${entries.length * 16}`}
        width="100%"
        role="img"
        aria-label={chartLabel}
      >
        {entries.map((entry, index) => {
          const barWidth = (entry.count / maxCount) * (chartWidth - 24);
          const y = index * 16 + 3;
          const label = `${entry.label}: ${entry.count}件`;

          return (
            <g key={entry.key}>
              <rect
                x={24}
                y={y}
                width={barWidth}
                height={10}
                rx={2}
                className="throughput-age-bar"
                aria-hidden="true"
              >
                <title>{label}</title>
              </rect>
              <text
                x={0}
                y={y + 8}
                className="throughput-age-axis-label"
                aria-hidden="true"
              >
                {entry.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function StatsCard({
  title,
  weeklyCloses,
  openTicketAge,
  cfdDays,
}: {
  title: string;
  weeklyCloses: readonly WeeklyCloseCountDto[];
  openTicketAge: AgeDistributionDto;
  cfdDays: readonly CfdDayEntryDto[];
}) {
  const weeklyLabel = `${title}の週次クローズ数`;
  const ageLabel = `${title}の未完了チケット年齢分布`;
  const cfdLabel = `${title}の累積フロー図`;

  return (
    <article className="throughput-stats-card">
      <h3 className="throughput-stats-card-title">{title}</h3>
      <StatsSection heading="スループット" description={SECTION_DESCRIPTIONS.throughput}>
        <WeeklyBarChart weeklyCloses={weeklyCloses} chartLabel={weeklyLabel} />
        <AgeBarChart distribution={openTicketAge} chartLabel={ageLabel} />
      </StatsSection>
      <StatsSection heading="フロー" description={SECTION_DESCRIPTIONS.flow}>
        <CfdStackedChart days={cfdDays} chartLabel={cfdLabel} />
      </StatsSection>
    </article>
  );
}

function hasAnyStatsData(stats: ThroughputStatsDto): boolean {
  if (hasAnyWeeklyCloses(stats.totals.weeklyCloses)) {
    return true;
  }
  if (hasAnyOpenTickets(stats.totals.openTicketAge)) {
    return true;
  }
  return stats.projects.some(
    (project) =>
      hasAnyWeeklyCloses(project.weeklyCloses) ||
      hasAnyOpenTickets(project.openTicketAge),
  );
}

function hasAnyDisplayedData(
  stats: ThroughputStatsDto | undefined,
  cfdStats: { totals: readonly CfdDayEntryDto[] } | undefined,
): boolean {
  if (stats !== undefined && hasAnyStatsData(stats)) {
    return true;
  }
  if (cfdStats !== undefined && hasAnyCfdData(cfdStats.totals)) {
    return true;
  }
  return false;
}

function findProjectCfdDays(
  cfdStats: { projects: readonly ProjectCfdStatsDto[] } | undefined,
  projectId: string,
): readonly CfdDayEntryDto[] {
  return cfdStats?.projects.find((project) => project.projectId === projectId)?.days ?? [];
}

function collectModelNames(
  weeklyCloses: readonly { counts: Record<string, number> }[],
  stageDistribution: readonly { counts: Record<string, number> }[],
): readonly string[] {
  const names = new Set<string>();
  for (const entry of weeklyCloses) {
    for (const model of Object.keys(entry.counts)) {
      names.add(model);
    }
  }
  for (const entry of stageDistribution) {
    for (const model of Object.keys(entry.counts)) {
      names.add(model);
    }
  }
  return [...names].sort();
}

function hasAnyModelStatsData(stats: ModelStatsDto): boolean {
  const hasWeekly = stats.weeklyCloses.some(
    (entry) => Object.keys(entry.counts).length > 0,
  );
  const hasStage = stats.stageModelDistribution.some(
    (entry) => Object.keys(entry.counts).length > 0,
  );
  return hasWeekly || hasStage;
}

function ModelStatsTables({ stats }: { stats: ModelStatsDto }) {
  if (!hasAnyModelStatsData(stats)) {
    return (
      <p className="empty-message">モデル別の実績データはまだありません</p>
    );
  }

  const modelNames = collectModelNames(
    stats.weeklyCloses,
    stats.stageModelDistribution,
  );

  return (
    <>
      <div className="throughput-chart-block">
        <ChartBlockHeader
          heading="モデル別クローズ件数(週次)"
          description={CHART_DESCRIPTIONS.modelWeeklyCloses}
          level={4}
        />
        <table className="model-stats-table">
          <thead>
            <tr>
              <th>週</th>
              {modelNames.map((model) => (
                <th key={model}>{model}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.weeklyCloses.map((entry) => (
              <tr key={entry.weekStart}>
                <td>{formatWeekLabel(entry.weekStart)}</td>
                {modelNames.map((model) => (
                  <td key={model}>{entry.counts[model] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="throughput-chart-block">
        <ChartBlockHeader
          heading="工程×モデルの分布"
          description={CHART_DESCRIPTIONS.modelStageDistribution}
          level={4}
        />
        <table className="model-stats-table">
          <thead>
            <tr>
              <th>工程</th>
              {modelNames.map((model) => (
                <th key={model}>{model}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.stageModelDistribution.map((entry) => (
              <tr key={entry.stage}>
                <td>{entry.stage}</td>
                {modelNames.map((model) => (
                  <td key={model}>{entry.counts[model] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HarnessKpiTable({ kpi }: { kpi: HarnessKpiDto }) {
  const dwell = kpi.pendingDecisionDwell;
  const reclaim = kpi.reclaim;

  const rows: readonly {
    key: string;
    label: string;
    value: string;
    note: string;
  }[] = [
    {
      key: 'pending-decision-dwell',
      label: '確認待ちの滞留 (中央値 / p90)',
      value: `${formatDurationMs(dwell.medianMs)} / ${formatDurationMs(dwell.p90Ms)}`,
      note:
        `期間内にクローズ ${dwell.closedCount}件・未回答 ${dwell.openCount}件。` +
        'human ラベル付きまたは gate タイプが対象で、ラベル付与時刻は bd から' +
        '取れないため作成時刻を起点にしています。',
    },
    {
      key: 'reclaim',
      label: 'reclaim 発火 / 直後の再 claim 率',
      value: `${reclaim.runCount}回 / ${formatRatePercent(reclaim.reclaimedThenInProgressRate)}`,
      note:
        `回収 ${reclaim.reclaimedCountTotal}件のうち ID を追えた ${reclaim.identifiedTicketCount}件中 ` +
        `${reclaim.reclaimedThenInProgressCount}件が ${Math.round(reclaim.windowMs / 60_000)}分以内に` +
        `再び作業中になりました (誤回収の代理指標)。記録はサーバー起動 ` +
        `${formatKpiTimestamp(reclaim.since)} 以降のみで、保存されません。`,
    },
    {
      key: 'harness-labeled',
      label: 'ハーネス起票率',
      value: formatShare(
        kpi.harnessLabeled.matchedCount,
        kpi.harnessLabeled.totalCount,
        kpi.harnessLabeled.rate,
      ),
      note: '期間内に作成されたチケットのうち harness / harness-upstream ラベルが付いた割合。',
    },
    {
      key: 'duplicate-mention',
      label: '重複 / 再発チケット比率',
      value: formatShare(
        kpi.duplicateMention.matchedCount,
        kpi.duplicateMention.totalCount,
        kpi.duplicateMention.rate,
      ),
      note:
        'タイトルまたは本文に「重複 / duplicate / 再発 / 二重 / 統合」を含む割合。' +
        '単語の一致だけを見る粗い指標なので、傾向の増減として読んでください。',
    },
  ];

  return (
    <div className="throughput-chart-block">
      <table className="model-stats-table">
        <thead>
          <tr>
            <th>指標</th>
            <th>値</th>
            <th>読み方</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.label}</td>
              <td>{row.value}</td>
              <td>{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ThroughputStats({
  projectIds,
  weeks,
  onWeeksChange,
}: ThroughputStatsProps) {
  const projectIdsKey = projectIds.join(',');
  const cfdDays = weeks * 7;
  const query = useQuery({
    queryKey: ['throughput-stats', weeks, projectIdsKey],
    queryFn: () => fetchThroughputStats(weeks, projectIds),
  });
  const cfdQuery = useQuery({
    queryKey: ['cfd-stats', cfdDays, projectIdsKey],
    queryFn: () => fetchCfdStats(cfdDays, projectIds),
  });
  const modelStatsQuery = useQuery({
    queryKey: ['model-stats', weeks, projectIdsKey],
    queryFn: () => fetchModelStats(weeks, projectIds),
  });
  const harnessKpiQuery = useQuery({
    queryKey: ['harness-kpi', weeks, projectIdsKey],
    queryFn: () => fetchHarnessKpi(weeks, projectIds),
  });

  const isLoading =
    query.isLoading ||
    cfdQuery.isLoading ||
    modelStatsQuery.isLoading ||
    harnessKpiQuery.isLoading;
  const isError =
    query.isError || cfdQuery.isError || modelStatsQuery.isError || harnessKpiQuery.isError;
  const errorMessage =
    (query.error instanceof Error ? query.error.message : undefined) ??
    (cfdQuery.error instanceof Error ? cfdQuery.error.message : undefined) ??
    (modelStatsQuery.error instanceof Error ? modelStatsQuery.error.message : undefined) ??
    (harnessKpiQuery.error instanceof Error ? harnessKpiQuery.error.message : undefined) ??
    '統計の読み込みに失敗しました';

  return (
    <section className="throughput-stats" aria-label="統計">
      <div className="throughput-stats-header">
        <h2 className="throughput-stats-title">統計</h2>
        <div className="throughput-weeks-group">
          <span className="header-label">期間</span>
          <div className="toggle-group">
            {STATS_WEEKS.map((option) => (
              <button
                key={option}
                type="button"
                className={`toggle-btn${weeks === option ? ' active' : ''}`}
                {...togglePressedProps(weeks === option)}
                onClick={() => onWeeksChange(option)}
              >
                {statsWeeksLabel(option)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading && <p className="loading">読み込み中…</p>}
      {isError && <p className="error-message">{errorMessage}</p>}
      {!isLoading &&
        !isError &&
        !hasAnyDisplayedData(query.data, cfdQuery.data) && (
          <p className="empty-message">この期間の統計データはありません</p>
        )}
      {!isLoading &&
        !isError &&
        hasAnyDisplayedData(query.data, cfdQuery.data) &&
        query.data !== undefined && (
          <div className="throughput-stats-cards">
            <StatsCard
              title="全体"
              weeklyCloses={query.data.totals.weeklyCloses}
              openTicketAge={query.data.totals.openTicketAge}
              cfdDays={cfdQuery.data?.totals ?? []}
            />
            {query.data.projects.map((project: ProjectThroughputStatsDto) => (
              <StatsCard
                key={project.projectId}
                title={project.projectName}
                weeklyCloses={project.weeklyCloses}
                openTicketAge={project.openTicketAge}
                cfdDays={findProjectCfdDays(cfdQuery.data, project.projectId)}
              />
            ))}
          </div>
        )}
      {!isLoading &&
        !isError &&
        modelStatsQuery.data !== undefined && (
          <section className="model-stats-block" aria-label="モデル別実績">
            <div className="throughput-stats-section-header">
              <h3 className="throughput-stats-section-heading">モデル別実績</h3>
              <p className="throughput-stats-section-description">
                {SECTION_DESCRIPTIONS.modelStats}
              </p>
            </div>
            <ModelStatsTables stats={modelStatsQuery.data} />
          </section>
        )}
      {!isLoading &&
        !isError &&
        harnessKpiQuery.data !== undefined && (
          <section className="model-stats-block" aria-label="ハーネスKPI">
            <div className="throughput-stats-section-header">
              <h3 className="throughput-stats-section-heading">ハーネスKPI</h3>
              <p className="throughput-stats-section-description">
                {SECTION_DESCRIPTIONS.harnessKpi}
              </p>
            </div>
            <HarnessKpiTable kpi={harnessKpiQuery.data} />
          </section>
        )}
    </section>
  );
}
