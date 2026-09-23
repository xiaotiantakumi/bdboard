import { compareStrings } from '../../../domain/compare.js';
import type { SessionLink } from '../../../domain/session.js';

export function dedupeAndSortLinks(links: readonly SessionLink[]): readonly SessionLink[] {
  const map = new Map<string, SessionLink>();
  for (const link of links) {
    const key = `${link.ticketId}\0${link.sessionId}`;
    map.set(key, link);
  }

  return [...map.values()].sort((a, b) => {
    const ticketCmp = compareStrings(a.ticketId, b.ticketId);
    if (ticketCmp !== 0) {
      return ticketCmp;
    }
    return compareStrings(a.sessionId, b.sessionId);
  });
}
