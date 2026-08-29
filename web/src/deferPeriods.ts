import { getBoardTimeZone } from './boardTimeZone';
import { localDateKey } from './components/activityFeedFormatting';

export type DeferPeriodKind = 'tomorrow' | '3days' | '1week' | '1month' | 'custom';

export const DEFAULT_DEFER_PERIOD: DeferPeriodKind = '1week';

export const DEFER_PERIOD_OPTIONS: readonly {
  kind: DeferPeriodKind;
  label: string;
}[] = [
  { kind: 'tomorrow', label: '明日' },
  { kind: '3days', label: '3日後' },
  { kind: '1week', label: '1週間後' },
  { kind: '1month', label: '1ヶ月後' },
  { kind: 'custom', label: '日付指定' },
];

function calendarDateKeyToUtcAnchor(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatUtcCalendarDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function boardCalendarAnchor(now: Date): Date {
  const key = localDateKey(now, getBoardTimeZone());
  return calendarDateKeyToUtcAnchor(key);
}

export function computeDeferUntilDate(
  kind: Exclude<DeferPeriodKind, 'custom'>,
  now: Date = new Date(),
): string {
  const target = boardCalendarAnchor(now);
  switch (kind) {
    case 'tomorrow':
      target.setUTCDate(target.getUTCDate() + 1);
      break;
    case '3days':
      target.setUTCDate(target.getUTCDate() + 3);
      break;
    case '1week':
      target.setUTCDate(target.getUTCDate() + 7);
      break;
    case '1month': {
      const originalDay = target.getUTCDate();
      target.setUTCDate(1);
      target.setUTCMonth(target.getUTCMonth() + 1);
      const daysInTargetMonth = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
      ).getUTCDate();
      target.setUTCDate(Math.min(originalDay, daysInTargetMonth));
      break;
    }
  }
  return formatUtcCalendarDate(target);
}

export function todayLocalDateInputValue(now: Date = new Date()): string {
  return localDateKey(now, getBoardTimeZone());
}

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isFutureLocalDate(value: string, now: Date = new Date()): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    return false;
  }

  const today = todayLocalDateInputValue(now);
  return value > today;
}
