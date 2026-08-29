import type { AgeDistributionDto } from '../api';
import { localDateKey } from './activityFeedFormatting';

export const AGE_BUCKET_KEYS = ['d0to1', 'd1to7', 'd7to30', 'd30plus'] as const;
export type AgeBucketKey = (typeof AGE_BUCKET_KEYS)[number];

export const AGE_BUCKET_LABELS: Record<AgeBucketKey, string> = {
  d0to1: '0-1日',
  d1to7: '1-7日',
  d7to30: '7-30日',
  d30plus: '30日以上',
};

export function formatWeekLabel(weekStartIso: string): string {
  const date = new Date(weekStartIso);
  return `${localDateKey(date)}の週`;
}

export function ageBucketEntries(
  distribution: AgeDistributionDto,
): readonly { key: AgeBucketKey; label: string; count: number }[] {
  return AGE_BUCKET_KEYS.map((key) => ({
    key,
    label: AGE_BUCKET_LABELS[key],
    count: distribution[key],
  }));
}

export function hasAnyOpenTickets(distribution: AgeDistributionDto): boolean {
  return AGE_BUCKET_KEYS.some((key) => distribution[key] > 0);
}

export function hasAnyWeeklyCloses(
  weeklyCloses: readonly { count: number }[],
): boolean {
  return weeklyCloses.some((entry) => entry.count > 0);
}
