import { useQuery } from '@tanstack/react-query';
import type { ProjectThroughputStatsDto } from '../api';
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
import { LoadingIndicator } from './LoadingIndicator';
import { togglePressedProps } from './toggleGroupA11y';
import { SECTION_DESCRIPTIONS } from './stats/constants';
import { findProjectCfdDays, hasAnyDisplayedData } from './stats/statsDataHelpers';
import { StatsCard } from './stats/StatsCard';
import { ModelStatsTables } from './stats/ModelStatsTables';
import { HarnessKpiTable } from './stats/HarnessKpiTable';

export interface ThroughputStatsProps {
  readonly projectIds: readonly string[];
  weeks: StatsWeeks;
  onWeeksChange: (weeks: StatsWeeks) => void;
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

  // ハーネスKPI は統計タブの中では付加的なブロックなので、ここが落ちても
  // スループット/CFD/モデル別実績まで巻き添えにしない (ブロック内だけで degrade する)。
  const isLoading = query.isLoading || cfdQuery.isLoading || modelStatsQuery.isLoading;
  const isError = query.isError || cfdQuery.isError || modelStatsQuery.isError;
  const errorMessage =
    (query.error instanceof Error ? query.error.message : undefined) ??
    (cfdQuery.error instanceof Error ? cfdQuery.error.message : undefined) ??
    (modelStatsQuery.error instanceof Error ? modelStatsQuery.error.message : undefined) ??
    '統計の読み込みに失敗しました';
  const harnessKpiErrorMessage =
    harnessKpiQuery.error instanceof Error
      ? harnessKpiQuery.error.message
      : 'ハーネスKPIの読み込みに失敗しました';

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

      {isLoading && <LoadingIndicator />}
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
      {!isLoading && !isError && (
        <section className="model-stats-block" aria-label="ハーネスKPI">
          <div className="throughput-stats-section-header">
            <h3 className="throughput-stats-section-heading">ハーネスKPI</h3>
            <p className="throughput-stats-section-description">
              {SECTION_DESCRIPTIONS.harnessKpi}
            </p>
          </div>
          {harnessKpiQuery.isLoading && <LoadingIndicator />}
          {!harnessKpiQuery.isLoading && harnessKpiQuery.isError && (
            <p className="error-message">{harnessKpiErrorMessage}</p>
          )}
          {!harnessKpiQuery.isLoading &&
            !harnessKpiQuery.isError &&
            harnessKpiQuery.data !== undefined && (
              <HarnessKpiTable kpi={harnessKpiQuery.data} />
            )}
        </section>
      )}
    </section>
  );
}
