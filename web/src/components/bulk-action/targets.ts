// bdboard-sso1.23 PR-A: BulkActionBar.tsx から純粋なターゲット選定関数を移動しただけの
// ファイル。挙動は一切変えていない。
import type { BoardCardDto, QuickActionRequest } from '../../api';
import type { BulkQuickActionTarget } from '../../bulkQuickAction';
import type { BulkConfirmingAction } from './types';

export function filterIdsPresentOnBoard(
  selectedIds: ReadonlySet<string>,
  cardsById: ReadonlyMap<string, BoardCardDto>,
): string[] {
  const ids: string[] = [];
  for (const id of selectedIds) {
    if (cardsById.has(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export function buildTargetsForAction(
  action: BulkConfirmingAction,
  selectedIds: ReadonlySet<string>,
  cardsById: ReadonlyMap<string, BoardCardDto>,
  closeReason: string,
): BulkQuickActionTarget[] {
  const targets: BulkQuickActionTarget[] = [];
  for (const id of selectedIds) {
    const card = cardsById.get(id);
    if (card === undefined) {
      continue;
    }
    const priority = card.ticket.priority;
    switch (action.kind) {
      case 'close': {
        const trimmedReason = closeReason.trim();
        const request: QuickActionRequest = {
          action: 'close',
          ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
        };
        targets.push({ id, request });
        break;
      }
      case 'defer':
        targets.push({
          id,
          request: { action: 'defer', untilDate: action.untilDate },
        });
        break;
      case 'priority-up':
        if (priority <= 0) {
          continue;
        }
        targets.push({
          id,
          request: { action: 'priority', priority: priority - 1 },
          previousPriority: priority,
        });
        break;
      case 'priority-down':
        if (priority >= 4) {
          continue;
        }
        targets.push({
          id,
          request: { action: 'priority', priority: priority + 1 },
          previousPriority: priority,
        });
        break;
      case 'add-label':
        break;
    }
  }
  return targets;
}

export function countEligibleForAction(
  action: BulkConfirmingAction,
  selectedIds: ReadonlySet<string>,
  cardsById: ReadonlyMap<string, BoardCardDto>,
): number {
  if (action.kind === 'add-label') {
    return filterIdsPresentOnBoard(selectedIds, cardsById).length;
  }
  return buildTargetsForAction(action, selectedIds, cardsById, '').length;
}
