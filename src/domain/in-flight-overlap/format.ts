import { OVERLAP_MESSAGE_FILE_LIMIT, type InFlightOverlapPeer } from './types.js';

/** `a.ts, b.ts (+3)` — 先頭 OVERLAP_MESSAGE_FILE_LIMIT 件だけ並べ、残りは件数で示す */
export function formatOverlapFiles(
  files: readonly string[],
  limit = OVERLAP_MESSAGE_FILE_LIMIT,
): string {
  const shown = files.slice(0, limit);
  const rest = files.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+${rest})` : shown.join(', ');
}

/** `bdboard-a: x.ts, y.ts (+3); bdboard-b: z.ts` — 相手ごとにファイルを丸めて並べる */
export function formatOverlapPeers(
  peers: readonly InFlightOverlapPeer[],
  limit = OVERLAP_MESSAGE_FILE_LIMIT,
): string {
  return peers
    .map((peer) => `${peer.ticketId}: ${formatOverlapFiles(peer.files, limit)}`)
    .join('; ');
}
