import type { CfdDayEntryDto } from '../../api';
import { CFD_STATUS_ORDER } from './constants';

export function formatCfdDateLabel(date: string): string {
  const [year, month, day] = date.split('-');
  if (year === undefined || month === undefined || day === undefined) {
    return date;
  }
  return `${month}/${day}`;
}

export function collectCfdStatuses(days: readonly CfdDayEntryDto[]): readonly string[] {
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

export function dayTotal(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export function hasAnyCfdData(days: readonly CfdDayEntryDto[]): boolean {
  return days.some((day) => dayTotal(day.counts) > 0);
}
