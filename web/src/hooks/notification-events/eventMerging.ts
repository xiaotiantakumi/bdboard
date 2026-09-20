import { MAX_EVENTS } from './constants';
import type { NotificationEventItem } from './types';

export function mergeUniqueNotificationEvents(
  prev: readonly NotificationEventItem[],
  incoming: readonly NotificationEventItem[],
): { merged: NotificationEventItem[]; added: NotificationEventItem[] } {
  if (incoming.length === 0) {
    return { merged: prev as NotificationEventItem[], added: [] };
  }
  const seenIds = new Set(prev.map((event) => event.id));
  const added: NotificationEventItem[] = [];
  for (const item of incoming) {
    if (seenIds.has(item.id)) {
      continue;
    }
    seenIds.add(item.id);
    added.push(item);
  }
  if (added.length === 0) {
    return { merged: prev as NotificationEventItem[], added };
  }
  return { merged: [...added, ...prev].slice(0, MAX_EVENTS), added };
}
