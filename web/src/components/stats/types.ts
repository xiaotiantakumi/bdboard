import type {
  AgeDistributionDto,
  CfdDayEntryDto,
  WeeklyCloseCountDto,
} from '../../api';

export interface WeeklyBarChartProps {
  weeklyCloses: readonly WeeklyCloseCountDto[];
  chartLabel: string;
}

export interface AgeBarChartProps {
  distribution: AgeDistributionDto;
  chartLabel: string;
}

export interface CfdStackedChartProps {
  days: readonly CfdDayEntryDto[];
  chartLabel: string;
}
