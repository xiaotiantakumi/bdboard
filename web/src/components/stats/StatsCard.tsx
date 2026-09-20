// bdboard-sso1.20: ThroughputStats.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
import type { AgeDistributionDto, CfdDayEntryDto, WeeklyCloseCountDto } from '../../api';
import { SECTION_DESCRIPTIONS } from './constants';
import { StatsSection } from './StatsSection';
import { WeeklyBarChart } from './WeeklyBarChart';
import { AgeBarChart } from './AgeBarChart';
import { CfdStackedChart } from './CfdStackedChart';

export function StatsCard({
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

