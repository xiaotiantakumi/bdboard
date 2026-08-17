import { type BoardDto, LANES } from './api';

/**
 * 1つの BoardDto から「ボード上に存在する」とみなせるチケットIDを集める。
 * bdboard-3tw.64 の既知ID自動リンク(MarkdownContent.tsx の remarkBeadIdLinks)は、
 * App.tsx の isTicketOnBoard(= このIDの集合に対する has())で「リンクにしてよいID」を
 * 判定している。
 *
 * カードとして表示されているレーン内チケットに加え、closedLimit で done レーンから
 * 切り捨てられたチケットのID(board.truncatedClosedIds)も含める。これを含めないと、
 * closedLimit を超えて非表示になった古い closed チケットへの相互参照(bdboardの
 * notes/comments は互いのIDを頻繁に参照する)がプレーンテキストに退行する
 * (bdboard-3tw.86 レビュー指摘の回帰)。
 */
export function collectBoardTicketIds(board: BoardDto, ids: Set<string>): void {
  for (const lane of LANES) {
    for (const card of board.lanes[lane] ?? []) {
      ids.add(card.ticket.id);
    }
  }
  for (const id of board.truncatedClosedIds) {
    ids.add(id);
  }
}
