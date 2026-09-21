// bdboard-sso1.48: SearchPalette.tsx の「表示行(アクション/チケット/最近開いた)
// の算出と選択中インデックス」に関する state + 算出 + effect 一式を、挙動を
// 変えずにこのカスタムフックへ抽出しただけのファイル。呼び出し順序・依存配列は
// 移動前から変えていない (PR 本文の effect 順序表を参照)。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TicketSearchResultDto } from '../../api';
import { filterPaletteActions, type PaletteAction } from '../../paletteActions';
import type { RecentTicketEntry } from '../../uiPersistedState';
import { buildPaletteRows, hasSamePaletteActionIds, type PaletteRow } from './types';

export interface UsePaletteRowsOptions {
  actions: PaletteAction[];
  trimmedQuery: string;
  hasQuery: boolean;
  ticketResults: TicketSearchResultDto[];
  recentTickets: RecentTicketEntry[];
}

export interface UsePaletteRowsResult {
  filteredActions: PaletteAction[];
  rows: PaletteRow[];
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
}

export function usePaletteRows({
  actions,
  trimmedQuery,
  hasQuery,
  ticketResults,
  recentTickets,
}: UsePaletteRowsOptions): UsePaletteRowsResult {
  // actions は呼び出し元 (App.tsx) の useMemo が毎レンダー新しい参照を返して
  // しまう場合があっても選択行がリセットされないよう、内容(id列)が前回と
  // 同じであれば直前の参照を再利用する保険的な対策 (bdboard-t43h)。
  // 根本原因である呼び出し元側の参照churnは別途修正済みだが、こちらは
  // 将来同種の回帰が起きても選択行リセットに波及させないための防御。
  const previousFilteredActionsRef = useRef<PaletteAction[]>([]);
  const filteredActions = useMemo(() => {
    const next = filterPaletteActions(actions, trimmedQuery);
    const previous = previousFilteredActionsRef.current;
    if (hasSamePaletteActionIds(previous, next)) {
      return previous;
    }
    previousFilteredActionsRef.current = next;
    return next;
  }, [actions, trimmedQuery]);

  const rows = useMemo<PaletteRow[]>(
    () => buildPaletteRows(filteredActions, ticketResults, recentTickets, hasQuery),
    [filteredActions, ticketResults, hasQuery, recentTickets],
  );

  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [rows]);

  return { filteredActions, rows, selectedIndex, setSelectedIndex };
}
