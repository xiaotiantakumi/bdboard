// bdboard-sso1.26: web/src/uiPersistedState.ts から move-only で分割。
// 挙動・型は変えていない (移動のみ)。

export const ACTIVITY_WINDOW_DAYS = [1, 3, 7] as const;
export type ActivityWindowDays = (typeof ACTIVITY_WINDOW_DAYS)[number];

export const STATS_WEEKS = [4, 8, 12] as const;
export type StatsWeeks = (typeof STATS_WEEKS)[number];

export function validateActivityWindowDays(value: unknown): ActivityWindowDays | null {
  if (value === 1 || value === 3 || value === 7) {
    return value;
  }
  return null;
}

export function validateStatsWeeks(value: unknown): StatsWeeks | null {
  if (value === 4 || value === 8 || value === 12) {
    return value;
  }
  return null;
}

export function activityWindowLabel(days: ActivityWindowDays): string {
  switch (days) {
    case 1:
      return '24時間';
    case 3:
      return '3日';
    case 7:
      return '7日';
  }
}

export function statsWeeksLabel(weeks: StatsWeeks): string {
  switch (weeks) {
    case 4:
      return '4週';
    case 8:
      return '8週';
    case 12:
      return '12週';
  }
}
