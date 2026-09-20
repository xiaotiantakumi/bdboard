// bdboard-sso1.26: web/src/uiPersistedState.ts から move-only で分割。
// 挙動・型は変えていない (移動のみ)。

export const RECENT_TICKETS_MAX = 10;

export interface RecentTicketEntry {
  id: string;
  title: string;
  projectName: string;
}

function validateRecentTicketEntry(value: unknown): RecentTicketEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    return null;
  }
  if (typeof record.title !== 'string') {
    return null;
  }
  if (typeof record.projectName !== 'string') {
    return null;
  }
  return {
    id: record.id,
    title: record.title,
    projectName: record.projectName,
  };
}

export function validateRecentTickets(value: unknown): RecentTicketEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: RecentTicketEntry[] = [];
  for (const item of value) {
    const entry = validateRecentTicketEntry(item);
    if (entry === null) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}

export function recordRecentTicket(
  current: RecentTicketEntry[],
  entry: RecentTicketEntry,
): RecentTicketEntry[] {
  const withoutDuplicate = current.filter((ticket) => ticket.id !== entry.id);
  const next = [entry, ...withoutDuplicate];
  return next.slice(0, RECENT_TICKETS_MAX);
}
