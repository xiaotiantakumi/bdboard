import { useEffect, useRef } from 'react';
import type { TicketDetailDto } from '../../api';
import { buildTicketWatchSnapshot, diffTicketWatchSnapshots, type TicketWatchSnapshot } from '../../ticketWatch';
import { buildWatchedNotificationEventItem } from './eventBuilders';
import type { NotificationEventItem, UseNotificationEventsOptions } from './types';

/**
 * Watches `options.watchedTicketIds` for board/detail transitions and appends
 * the resulting notification items via `appendNotificationItems`.
 *
 * Extracted move-only from useNotificationEvents.ts (bdboard-sso1.30 PR-C):
 * this owns exactly one effect and its private ref (`watchedSnapshotsRef`),
 * called at the same relative position the effect occupied before the split,
 * with an unchanged dependency array — see the PR body for the effect-order
 * invariance table.
 */
export function useWatchedTicketNotifications(
  options: UseNotificationEventsOptions | undefined,
  appendNotificationItems: (items: readonly NotificationEventItem[]) => void,
): void {
  const watchedSnapshotsRef = useRef<Map<string, TicketWatchSnapshot>>(new Map());

  const watchedTicketIds = options?.watchedTicketIds;
  const boardCardsById = options?.boardCardsById;
  const watchedTicketDetails = options?.watchedTicketDetails;

  useEffect(() => {
    if (
      watchedTicketIds === undefined ||
      watchedTicketIds.size === 0 ||
      boardCardsById === undefined
    ) {
      watchedSnapshotsRef.current = new Map();
      return;
    }

    const details = watchedTicketDetails ?? new Map<string, TicketDetailDto>();
    const occurredAt = new Date().toISOString();
    const newItems: NotificationEventItem[] = [];
    const nextSnapshots = new Map<string, TicketWatchSnapshot>();

    for (const ticketId of watchedTicketIds) {
      const current = buildTicketWatchSnapshot(ticketId, boardCardsById, details);
      if (current === null) {
        const previous = watchedSnapshotsRef.current.get(ticketId);
        if (previous !== undefined) {
          nextSnapshots.set(ticketId, previous);
        }
        continue;
      }

      const previous = watchedSnapshotsRef.current.get(ticketId);
      if (previous === undefined) {
        nextSnapshots.set(ticketId, current);
        continue;
      }

      const transitions = diffTicketWatchSnapshots(previous, current);
      for (const transition of transitions) {
        newItems.push(buildWatchedNotificationEventItem(transition, current, occurredAt));
      }
      nextSnapshots.set(ticketId, current);
    }

    watchedSnapshotsRef.current = nextSnapshots;
    appendNotificationItems(newItems);
  }, [watchedTicketIds, boardCardsById, watchedTicketDetails, appendNotificationItems]);
}
