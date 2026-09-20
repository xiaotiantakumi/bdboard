import { compareStrings } from '../compare.js';
import { livenessRank } from '../liveness.js';
import type { BoardCard } from './types.js';

export function compareCards(a: BoardCard, b: BoardCard): number {
  const effectiveDiff = a.effectivePriority - b.effectivePriority;
  if (effectiveDiff !== 0) {
    return effectiveDiff;
  }

  const priorityDiff = a.ticket.priority - b.ticket.priority;
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const aLivenessRank = a.liveness === null ? 4 : livenessRank(a.liveness);
  const bLivenessRank = b.liveness === null ? 4 : livenessRank(b.liveness);
  if (aLivenessRank !== bLivenessRank) {
    return aLivenessRank - bLivenessRank;
  }

  if (a.unblocksCount !== b.unblocksCount) {
    return b.unblocksCount - a.unblocksCount;
  }

  const updatedDiff = b.ticket.updatedAt.getTime() - a.ticket.updatedAt.getTime();
  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  const idDiff = compareStrings(a.ticket.id, b.ticket.id);
  if (idDiff !== 0) {
    return idDiff;
  }

  return compareStrings(a.projectId, b.projectId);
}
