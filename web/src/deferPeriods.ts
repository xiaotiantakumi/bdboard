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

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function computeDeferUntilDate(
  kind: Exclude<DeferPeriodKind, 'custom'>,
  now: Date = new Date(),
): string {
  const target = new Date(now.getTime());
  switch (kind) {
    case 'tomorrow':
      target.setDate(target.getDate() + 1);
      break;
    case '3days':
      target.setDate(target.getDate() + 3);
      break;
    case '1week':
      target.setDate(target.getDate() + 7);
      break;
    case '1month': {
      const originalDay = target.getDate();
      target.setDate(1);
      target.setMonth(target.getMonth() + 1);
      const daysInTargetMonth = new Date(
        target.getFullYear(),
        target.getMonth() + 1,
        0,
      ).getDate();
      target.setDate(Math.min(originalDay, daysInTargetMonth));
      break;
    }
  }
  return formatLocalDate(target);
}

export function todayLocalDateInputValue(now: Date = new Date()): string {
  return formatLocalDate(now);
}

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isFutureLocalDate(value: string, now: Date = new Date()): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    return false;
  }

  const today = formatLocalDate(now);
  return value > today;
}
