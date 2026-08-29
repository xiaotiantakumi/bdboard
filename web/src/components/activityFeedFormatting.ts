// Date/time labels follow a configurable board timezone rather than the host
// process timezone. The host varies between local dev and CI (UTC), so
// date-boundary math must pin to an explicit IANA zone via Intl (see bdboard-3tw.75).
import { getBoardTimeZone } from '../boardTimeZone';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function getDateKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateKeyFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateKeyFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function getTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = timeFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('ja-JP', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    timeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function localDateKey(date: Date, timeZone?: string): string {
  const zone = timeZone ?? getBoardTimeZone();
  return getDateKeyFormatter(zone).format(date);
}

export function formatActivityDateHeading(
  date: Date,
  now: Date,
  timeZone?: string,
): string {
  const zone = timeZone ?? getBoardTimeZone();
  const dateKey = localDateKey(date, zone);
  const todayKey = localDateKey(now, zone);
  const yesterdayKey = localDateKey(new Date(now.getTime() - ONE_DAY_MS), zone);

  if (dateKey === todayKey) {
    return '今日';
  }
  if (dateKey === yesterdayKey) {
    return '昨日';
  }
  return dateKey;
}

export function formatActivityTime(date: Date, timeZone?: string): string {
  const zone = timeZone ?? getBoardTimeZone();
  const parts = getTimeFormatter(zone).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

export const ACTIVITY_KIND_LABELS = {
  created: '作成',
  started: '着手',
  closed: '完了',
  status_changed: '状態変更',
  priority_changed: '優先度変更',
  field_changed: '変更',
} as const;

export interface ActivityDateGroup<T extends { at: string }> {
  readonly heading: string;
  readonly events: readonly T[];
}

export function groupEventsByDate<T extends { at: string }>(
  events: readonly T[],
  now: Date,
  timeZone?: string,
): readonly ActivityDateGroup<T>[] {
  const zone = timeZone ?? getBoardTimeZone();
  const groups = new Map<string, T[]>();
  const headings = new Map<string, string>();

  for (const event of events) {
    const at = new Date(event.at);
    const key = localDateKey(at, zone);
    const heading = formatActivityDateHeading(at, now, zone);

    if (!groups.has(key)) {
      groups.set(key, []);
      headings.set(key, heading);
    }
    groups.get(key)?.push(event);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([key, groupedEvents]) => ({
      heading: headings.get(key) ?? key,
      events: groupedEvents,
    }));
}
