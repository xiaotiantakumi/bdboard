// bdboard-sso1.48: SearchPalette.tsx から純粋な型・定数・ヘルパーを移動しただけの
// ファイル。挙動は一切変えていない。
import type { TicketSearchResultDto } from '../../api';
import type { PaletteAction } from '../../paletteActions';
import type { RecentTicketEntry } from '../../uiPersistedState';

export type PaletteRow =
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'ticket'; ticket: TicketSearchResultDto }
  | { kind: 'recent'; ticket: RecentTicketEntry };

export const EMPTY_RECENT_TICKETS: RecentTicketEntry[] = [];

/**
 * filteredActions の内容(id列)が前回と同じかどうかを判定する。actions は
 * 呼び出し元 (App.tsx) の useMemo が毎レンダー新しい参照を返してしまう場合が
 * あっても選択行がリセットされないよう、内容が同じなら直前の参照を再利用する
 * 保険的な対策 (bdboard-t43h) の一部。
 */
export function hasSamePaletteActionIds(
  previous: PaletteAction[],
  next: PaletteAction[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((action, index) => action.id === next[index]?.id)
  );
}

export function buildPaletteRows(
  filteredActions: PaletteAction[],
  ticketResults: TicketSearchResultDto[],
  recentTickets: RecentTicketEntry[],
  hasQuery: boolean,
): PaletteRow[] {
  const actionRows: PaletteRow[] = filteredActions.map((action) => ({
    kind: 'action',
    action,
  }));

  if (!hasQuery) {
    const recentRows: PaletteRow[] = recentTickets.map((ticket) => ({
      kind: 'recent',
      ticket,
    }));
    return [...actionRows, ...recentRows];
  }

  const ticketRows: PaletteRow[] = ticketResults.map((ticket) => ({
    kind: 'ticket',
    ticket,
  }));
  return [...actionRows, ...ticketRows];
}
