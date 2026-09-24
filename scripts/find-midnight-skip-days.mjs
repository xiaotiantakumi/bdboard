// bdboard-0uy7: regenerates the `skippedMidnightDays` fixture table in
// src/application/board/board-date-time.test.ts.
//
// That table lists (dateKey, timeZone) pairs where local midnight is
// skipped by a DST transition ("spring forward across 00:00", e.g.
// America/Santiago). It's a snapshot of one IANA tzdata release: when the
// Node/ICU build's bundled tzdata is updated (a country changes its DST
// rules), some pairs stop being real transition days under the new data.
// The test file detects that drift at runtime and points here when too many
// pairs have gone stale.
//
// This script re-derives the table from scratch by brute-force scanning
// every IANA time zone this Node build knows about, for every calendar day
// in a year range, using the same "does local midnight for this date
// exist" check board-date-time.ts's zonedMidnight() relies on.
//
// Usage:
//   node scripts/find-midnight-skip-days.mjs [startYear] [endYear]
// Defaults to 2015-2030, matching the current fixture table's range. Paste
// the printed array literal over `skippedMidnightDays` in
// board-date-time.test.ts, and update the "has exactly N known
// skipped-midnight days" assertion in the same file to match the new count.

function getOffsetMs(utcMs, offsetFormatter) {
  const parts = offsetFormatter.formatToParts(new Date(utcMs));
  const lookup = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }
  const asUtc = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
    Number(lookup.hour),
    Number(lookup.minute),
    Number(lookup.second),
  );
  return asUtc - utcMs;
}

function isMidnightSkipped(dateKey, offsetFormatter, keyFormatter) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const offset1 = getOffsetMs(utcGuess, offsetFormatter);
  const candidate1 = utcGuess - offset1;
  const offset2 = getOffsetMs(candidate1, offsetFormatter);
  if (offset2 === offset1) {
    return false;
  }
  const candidate2 = utcGuess - offset2;
  return keyFormatter.format(new Date(candidate2)) !== dateKey;
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Calendar dateKeys for [startYear, endYear] are enumerated directly from a
// proleptic UTC calendar (Date.UTC(year, 0, 1 + dayOfYear) read back as a UTC
// y/m/d), not by formatting UTC instants into the target timeZone: a probe
// instant can never land on a date whose local midnight doesn't exist, so
// deriving candidate dateKeys from per-zone local formatting would silently
// skip over exactly the skipped dates this script exists to find.
function calendarDateKeys(startYear, endYear) {
  const keys = [];
  for (let year = startYear; year <= endYear; year += 1) {
    const daysInYear = isLeapYear(year) ? 366 : 365;
    for (let dayOfYear = 0; dayOfYear < daysInYear; dayOfYear += 1) {
      const utc = new Date(Date.UTC(year, 0, 1 + dayOfYear));
      const y = utc.getUTCFullYear();
      const m = String(utc.getUTCMonth() + 1).padStart(2, '0');
      const d = String(utc.getUTCDate()).padStart(2, '0');
      keys.push(`${y}-${m}-${d}`);
    }
  }
  return keys;
}

function scanZone(timeZone, dateKeys) {
  const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const keyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dateKeys.filter((dateKey) => isMidnightSkipped(dateKey, offsetFormatter, keyFormatter));
}

function main() {
  const [startYearArg, endYearArg] = process.argv.slice(2);
  const startYear = Number(startYearArg) || 2015;
  const endYear = Number(endYearArg) || 2030;

  const zones = Intl.supportedValuesOf('timeZone');
  const dateKeys = calendarDateKeys(startYear, endYear);
  const results = [];
  for (const timeZone of zones) {
    for (const dateKey of scanZone(timeZone, dateKeys)) {
      results.push([dateKey, timeZone]);
    }
  }
  results.sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1].localeCompare(b[1])));

  console.log(`Found ${results.length} skip-midnight (dateKey, timeZone) pairs, ${startYear}-${endYear}:\n`);
  for (const [dateKey, timeZone] of results) {
    console.log(`    ['${dateKey}', '${timeZone}'],`);
  }
}

main();
