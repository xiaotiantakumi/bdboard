import type { AgeDistributionDto } from '../api';
import { formatActivityTime, localDateKey } from './activityFeedFormatting';

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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 値が無いときの表示 (件数 0 と「測れなかった」を見分けるため '0' にはしない)。 */
export const NO_VALUE_LABEL = '—';

/**
 * 滞留時間の人向け表記。桁が変わるところで単位を切り替える。
 * null は NO_VALUE_LABEL。
 */
export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return NO_VALUE_LABEL;
  }
  if (ms < MINUTE_MS) {
    return `${Math.round(ms / 1000)}秒`;
  }
  if (ms < HOUR_MS) {
    return `${Math.round(ms / MINUTE_MS)}分`;
  }
  if (ms < DAY_MS) {
    return `${(ms / HOUR_MS).toFixed(1)}時間`;
  }
  return `${(ms / DAY_MS).toFixed(1)}日`;
}

/** 0〜1 の比率を百分率に。null は NO_VALUE_LABEL。 */
export function formatRatePercent(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) {
    return NO_VALUE_LABEL;
  }
  return `${(rate * 100).toFixed(1)}%`;
}

/** 「n件 / N件 (x%)」。母数 0 のときは率を出さない。 */
export function formatShare(
  matchedCount: number,
  totalCount: number,
  rate: number | null,
): string {
  if (totalCount === 0) {
    return `0件 / 0件 (${NO_VALUE_LABEL})`;
  }
  return `${matchedCount}件 / ${totalCount}件 (${formatRatePercent(rate)})`;
}

/** ISO 文字列を「YYYY-MM-DD HH:mm」相当のローカル表記にする。null はそのまま欠測表示。 */
export function formatKpiTimestamp(iso: string | null): string {
  if (iso === null) {
    return NO_VALUE_LABEL;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return NO_VALUE_LABEL;
  }
  return `${localDateKey(date)} ${formatActivityTime(date)}`;
}
