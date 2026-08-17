// This app is single-user (JST) and its date/time labels are meant to read
// as JST regardless of the host process's own timezone — the host varies
// between local dev (JST) and CI (UTC), so date-boundary math must be
// pinned to Asia/Tokyo rather than using Date's local-timezone accessors
// (getFullYear/getMonth/getDate/getHours/getMinutes), which silently follow
// whatever TZ the process happens to run in (see bdboard-3tw.75).
const JST_TIME_ZONE = 'Asia/Tokyo';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// en-CA formats as YYYY-MM-DD, which is exactly the key format we want.
const jstDateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: JST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const jstTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: JST_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function localDateKey(date: Date): string {
  return jstDateKeyFormatter.format(date);
}

export function formatActivityDateHeading(date: Date, now: Date): string {
  const dateKey = localDateKey(date);
  const todayKey = localDateKey(now);
  // Shift by exactly 24h in absolute time rather than Date's local-TZ
  // setDate/getDate, so this stays decoupled from the host's timezone too.
  const yesterdayKey = localDateKey(new Date(now.getTime() - ONE_DAY_MS));

  if (dateKey === todayKey) {
    return '今日';
  }
  if (dateKey === yesterdayKey) {
    return '昨日';
  }
  return dateKey;
}

export function formatActivityTime(date: Date): string {
  const parts = jstTimeFormatter.formatToParts(date);
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
): readonly ActivityDateGroup<T>[] {
  const groups = new Map<string, T[]>();
  const headings = new Map<string, string>();

  for (const event of events) {
    const at = new Date(event.at);
    const key = localDateKey(at);
    const heading = formatActivityDateHeading(at, now);

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
