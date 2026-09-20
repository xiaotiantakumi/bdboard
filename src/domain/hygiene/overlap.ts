import {
  collectOverlapPeersByTicket,
  formatOverlapPeers,
  type InFlightOverlap,
  type InFlightOverlapPeer,
} from '../in-flight-overlap.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';
import type { HygieneIssue, HygieneOverlapPeer } from './types.js';

/**
 * 着手中チケット同士のファイル重複を、**1 チケット 1 行** に畳んで出す。
 *
 * 相手が複数いてもチケットあたり 1 行にする。ペアごとに 1 行だと、3 件と重なって
 * いるチケットが 3 行に散って読みにくいうえ、UI 側の行キー (kind + ticketId) が
 * 一意でなくなる。相手は message と `overlaps` に並べる。
 *
 * 一方で **対称性は保つ**: 片側だけに出すと相手のチケットを開いている人には何も
 * 見えないので、ペアの両側それぞれに 1 行ずつ出す。
 *
 * severity は info。重複していること自体はまだ失敗ではなく「今のうちに片方へ寄せるか
 * 順番を決めろ」という合図で、warning にすると本当に直すべき行に埋もれる。
 */
export function checkInFlightOverlaps(
  overlaps: readonly InFlightOverlap[],
  ticketById: ReadonlyMap<TicketId, Ticket>,
): readonly HygieneIssue[] {
  const issues: HygieneIssue[] = [];

  for (const group of collectOverlapPeersByTicket(overlaps)) {
    const ticket = ticketById.get(group.ticketId);
    if (ticket === undefined) {
      continue;
    }
    if (ticket.projectId !== group.projectId) {
      continue;
    }

    const peers: readonly HygieneOverlapPeer[] = group.peers.map(
      (peer: InFlightOverlapPeer) => ({
        otherTicketId: peer.ticketId,
        files: peer.files,
      }),
    );

    issues.push({
      kind: 'in_flight_file_overlap',
      ticketId: group.ticketId,
      projectId: group.projectId,
      message: `着手中の ${peers.length} 件と同じファイルを編集中: ${formatOverlapPeers(group.peers)}`,
      severity: 'info',
      overlaps: peers,
    });
  }

  return issues;
}
