import { compareStrings } from '../compare.js';
import type { TicketId } from '../ticket-id.js';
import { entryKey, type InFlightOverlap, type InFlightOverlapPeer } from './types.js';

/** 1 チケットから見た重複相手ぜんぶ。Hygiene の 1 行ぶん */
export interface InFlightOverlapGroup {
  readonly projectId: string;
  readonly ticketId: TicketId;
  /** 相手 ID 昇順。必ず 1 件以上 */
  readonly peers: readonly InFlightOverlapPeer[];
}

/**
 * ペアの一覧を **チケット単位** に畳む。
 *
 * Hygiene は 1 チケット 1 行に集約したい (相手が 3 件あると 3 行に散り、UI の行キーも
 * チケット ID だけでは一意にならない) が、重複という事実自体は対称なので、ペアの
 * 両側それぞれについてグループを作る。並びは projectId → ticketId 昇順。
 */
export function collectOverlapPeersByTicket(
  overlaps: readonly InFlightOverlap[],
): readonly InFlightOverlapGroup[] {
  const groups = new Map<
    string,
    { projectId: string; ticketId: TicketId; peers: InFlightOverlapPeer[] }
  >();

  const push = (projectId: string, ticketId: TicketId, peer: InFlightOverlapPeer): void => {
    const key = entryKey(projectId, ticketId);
    let slot = groups.get(key);
    if (slot === undefined) {
      slot = { projectId, ticketId, peers: [] };
      groups.set(key, slot);
    }
    slot.peers.push(peer);
  };

  for (const overlap of overlaps) {
    const [a, b] = overlap.ticketIds;
    push(overlap.projectId, a, { ticketId: b, files: overlap.files });
    push(overlap.projectId, b, { ticketId: a, files: overlap.files });
  }

  return [...groups.values()]
    .map((slot) => ({
      projectId: slot.projectId,
      ticketId: slot.ticketId,
      peers: [...slot.peers].sort((x, y) => compareStrings(x.ticketId, y.ticketId)),
    }))
    .sort((a, b) => {
      const projectDiff = compareStrings(a.projectId, b.projectId);
      return projectDiff !== 0 ? projectDiff : compareStrings(a.ticketId, b.ticketId);
    });
}
