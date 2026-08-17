const MS_PER_DAY = 86_400_000;

/**
 * Midnight of the given instant's calendar day, in the running process's own
 * timezone.
 *
 * Deliberately local rather than UTC. The board is read by a person in their own
 * timezone, and the server runs on their machine, so "today" has to mean their
 * today. Truncating in UTC put a JST user up to nine hours out: a ticket coming
 * back at 09:00 on the 15th JST is still the 14th in UTC and would read as "1 day
 * left" all morning. This stays pure -- the result depends only on the arguments
 * and the process timezone, never on an ambient clock.
 */
function truncateToLocalDayMs(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/**
 * Calendar-day distance between `now` and `deferUntil`.
 * Both are truncated to local midnight before subtracting, so a ticket returning
 * later today reads as 0 rather than as a fraction rounded either way, and a date
 * already passed stays negative.
 */
export function daysUntilDefer(deferUntil: Date, now: Date): number | null {
  if (
    Number.isNaN(deferUntil.getTime()) ||
    Number.isNaN(now.getTime())
  ) {
    return null;
  }

  const deferDay = truncateToLocalDayMs(deferUntil);
  const nowDay = truncateToLocalDayMs(now);
  // Rounding absorbs the one-hour jump when a DST transition falls between the
  // two days; without it a 23- or 25-hour gap would land on 0.96 or 1.04 days.
  return Math.round((deferDay - nowDay) / MS_PER_DAY);
}

export type DeferUrgency = 'overdue' | 'today' | 'soon' | 'later';

export function deriveDeferUrgency(
  deferUntil: Date,
  now: Date,
): DeferUrgency | null {
  const days = daysUntilDefer(deferUntil, now);
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
