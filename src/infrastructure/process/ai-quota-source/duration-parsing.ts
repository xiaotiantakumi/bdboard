export function parseDurationMs(text: string): number | undefined {
  const re = /(\d+)\s*(d|h|m|s)\b/gi;
  let match: RegExpExecArray | null;
  let totalMs = 0;
  let found = false;

  while ((match = re.exec(text)) !== null) {
    found = true;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const unitMs =
      unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
    totalMs += value * unitMs;
  }

  return found ? totalMs : undefined;
}

export function parseAbsoluteResetAt(text: string, fetchedAt: Date): Date | undefined {
  const match = text.match(
    /^(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s+on\s+([A-Za-z]{3})\s+(\d{1,2}))?$/i,
  );
  if (!match) {
    return undefined;
  }

  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') {
    hour += 12;
  }
  const minute = Number(match[2]);
  const monthNames = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];
  const month = match[4]?.toLowerCase();
  const monthIndex = month === undefined ? fetchedAt.getMonth() : monthNames.indexOf(month);
  if (monthIndex < 0) {
    return undefined;
  }

  const day = match[5] === undefined ? fetchedAt.getDate() : Number(match[5]);
  const resetAt = new Date(fetchedAt.getFullYear(), monthIndex, day, hour, minute, 0, 0);
  if (Number.isNaN(resetAt.getTime())) {
    return undefined;
  }

  if (resetAt.getTime() <= fetchedAt.getTime()) {
    if (match[4] === undefined) {
      resetAt.setDate(resetAt.getDate() + 1);
    } else {
      resetAt.setFullYear(resetAt.getFullYear() + 1);
    }
  }
  return resetAt;
}
