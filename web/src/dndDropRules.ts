import type { Lane } from './api';

export type DropActionKind = 'claim' | 'close' | 'reject';

export interface DropActionResult {
  kind: DropActionKind;
}

/**
 * Maps a card drag from sourceLane to targetLane onto a bd quick-action, or reject.
 *
 * Adopted rules (beyond the explicit spec):
 * - Same-lane drops are rejected.
 * - Drops from done are rejected (no quick-action to reopen).
 * - Drops onto blocked are rejected (derived display lane, not a single bd
 *   status — since bdboard-662 it merges dependency-derived blocking AND the
 *   'deferred' bd status, so there is no single unambiguous quick-action for
 *   a drop here). Deferring a ticket is still available as a quick-action
 *   button in the ticket detail panel ("1週間延期"), just not via drag-to-blocked.
 * - Drops onto awaiting_human are rejected (derived display lane driven by the
 *   bd human label, not a bd status — there is no quick-action to add the
 *   label). Dragging a card OUT of awaiting_human still falls through to the
 *   generic rules below (e.g. → done still closes), same as any other
 *   non-done source lane.
 * - Only ready → in_progress maps to claim; other lanes cannot move back to
 *   ready via quick-action.
 */
export function resolveDropAction(
  sourceLane: Lane,
  targetLane: Lane,
): DropActionResult {
  if (sourceLane === targetLane) {
    return { kind: 'reject' };
  }

  if (targetLane === 'blocked' || targetLane === 'awaiting_human') {
    return { kind: 'reject' };
  }

  if (sourceLane === 'done') {
    return { kind: 'reject' };
  }

  if (targetLane === 'done') {
    return { kind: 'close' };
  }

  if (sourceLane === 'ready' && targetLane === 'in_progress') {
    return { kind: 'claim' };
  }

  return { kind: 'reject' };
}

export function isDropAllowed(sourceLane: Lane, targetLane: Lane): boolean {
  return resolveDropAction(sourceLane, targetLane).kind !== 'reject';
}
