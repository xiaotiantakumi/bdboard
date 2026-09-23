import type { TicketId } from '../ticket-id.js';

/**
 * 着手中チケット同士のファイル重複 (npm run drift の「着手中版」)。
 *
 * `npm run drift` は「main と自分のブランチが両方触ったファイル」を PR 直前に出すが、
 * **並列で着手した別チケット同士**の干渉は rebase で衝突するまで誰にも見えない
 * (docs/HARNESS-EVALUATION.md §3.2(b))。ここはその欠けている辺を、worktree から
 * 取った変更ファイル集合の交差として計算する純粋関数。
 *
 * bdboard-sso1.76: このファイルは共有の型・定数・cross-module ヘルパーのみ。実装は
 * ./compute.ts (computeInFlightOverlaps / overlapPeersForTicket)・./format.ts
 * (formatOverlapFiles / formatOverlapPeers)・./group-by-ticket.ts (InFlightOverlapGroup /
 * collectOverlapPeersByTicket)・./worktrees.ts (InFlightWorktree / selectInFlightWorktrees)
 * に分割されている。公開エクスポートの入口は ../in-flight-overlap.ts (バレル)。
 */

/** 1 チケット = 1 worktree ぶんの変更ファイル集合 */
export interface InFlightFileEntry {
  readonly ticketId: TicketId;
  readonly projectId: string;
  /** リポジトリルート相対のパス。順序・重複は問わない */
  readonly files: readonly string[];
}

/** 同じファイルを触っているチケット **ペア** */
export interface InFlightOverlap {
  readonly projectId: string;
  /** 昇順に整列した 2 件。ペアは無向なので [a, b] と [b, a] は同一 */
  readonly ticketIds: readonly [TicketId, TicketId];
  /** 昇順に整列した交差ファイル。必ず 1 件以上 */
  readonly files: readonly string[];
}

/** 詳細パネル向けに「相手 1 件ぶん」へ畳んだ形 */
export interface InFlightOverlapPeer {
  readonly ticketId: TicketId;
  readonly files: readonly string[];
}

/** メッセージに列挙するファイル数の上限 */
export const OVERLAP_MESSAGE_FILE_LIMIT = 5;

// bdboard-sso1.76: 分割前は同一ファイル内の非公開関数 (export なし) だった。./compute.ts・
// ./group-by-ticket.ts・./worktrees.ts の3ファイルが使うため export を付けている。
// 公開エクスポート面 (../in-flight-overlap.ts) には出さない。
export function entryKey(projectId: string, ticketId: TicketId): string {
  return `${projectId}\0${ticketId}`;
}
