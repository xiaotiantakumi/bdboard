const MS_PER_DAY = 86_400_000;

/**
 * Midnight of the given instant's calendar day.
 *
 * Without `timeZone`, uses the running process's own timezone via local Date
 * getters — the board is read by a person in their own timezone, and the server
 * runs on their machine, so "today" has to mean their today.
 *
 * With `timeZone`, uses Intl to read the calendar day in that IANA zone and
 * returns a UTC anchor (`Date.UTC(y, m-1, d)`) so both operands share the same
 * truncation scheme. Stays pure — depends only on arguments, never on an ambient
 * clock.
 */
function truncateToLocalDayMs(date: Date, timeZone?: string): number {
  if (timeZone === undefined) {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    ).getTime();
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }
  return Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
  );
}

/**
 * Calendar-day distance between `now` and `deferUntil`.
 * Both are truncated to local midnight before subtracting, so a ticket returning
 * later today reads as 0 rather than as a fraction rounded either way, and a date
 * already passed stays negative.
 */
export function daysUntilDefer(
  deferUntil: Date,
  now: Date,
  timeZone?: string,
): number | null {
  if (
    Number.isNaN(deferUntil.getTime()) ||
    Number.isNaN(now.getTime())
  ) {
    return null;
  }

  const deferDay = truncateToLocalDayMs(deferUntil, timeZone);
  const nowDay = truncateToLocalDayMs(now, timeZone);
  // Rounding absorbs the one-hour jump when a DST transition falls between the
  // two days; without it a 23- or 25-hour gap would land on 0.96 or 1.04 days.
  return Math.round((deferDay - nowDay) / MS_PER_DAY);
}

export type DeferUrgency = 'overdue' | 'today' | 'soon' | 'later';

export function deriveDeferUrgency(
  deferUntil: Date,
  now: Date,
  timeZone?: string,
): DeferUrgency | null {
  const days = daysUntilDefer(deferUntil, now, timeZone);
  if (days === null) {
    return null;
  }

  if (days < 0) {
    return 'overdue';
  }
  if (days === 0) {
    return 'today';
  }
  if (days <= 3) {
    return 'soon';
  }
  return 'later';
}
