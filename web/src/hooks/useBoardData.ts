import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchBoard, type BoardCardDto, type BoardMode } from '../api';
import {
  collectBoardCardsById,
  collectBoardLabels,
  collectBoardTicketIds,
} from '../boardTicketIds';
import { compareStrings } from '../compare';

/**
 * bdboard-62p4 PR-3: App.tsx の `board` クエリと、その `data` から導出する
 * 3つの useMemo (boardTicketIds/availableLabels/boardCardsById) を集約した。
 * queryKey/queryFn と各 useMemo の依存配列・本体は元の App.tsx
 * (旧 L265-273, L460-511) から1文字も変えていない。
 */
export interface UseBoardDataParams {
  boardApiMode: BoardMode;
  selectedProjectIds: string[];
  selectedProjectIdsJoined: string;
  epicFilterId: string | undefined;
}

export function useBoardData({
  boardApiMode,
  selectedProjectIds,
  selectedProjectIdsJoined,
  epicFilterId,
}: UseBoardDataParams) {
  const boardQuery = useQuery({
    queryKey: ['board', boardApiMode, selectedProjectIdsJoined, epicFilterId],
    queryFn: () =>
      fetchBoard({
        projectIds: selectedProjectIds,
        view: boardApiMode,
        ...(epicFilterId !== undefined ? { epicId: epicFilterId } : {}),
      }),
  });

  const boardTicketIds = useMemo(() => {
    const ids = new Set<string>();
    const data = boardQuery.data;
    if (data === undefined) {
      return ids;
    }
    if (data.merged !== null) {
      collectBoardTicketIds(data.merged, ids);
    }
    for (const entry of data.projects) {
      collectBoardTicketIds(entry.board, ids);
    }
    return ids;
  }, [boardQuery.data]);

  // undefined = 「盤面をまだ知らない」(初回描画・クエリキー変更直後・取得失敗で
  // data が undefined のまま)。空配列 = 「盤面は分かっていてラベルが 1 つも無い」。
  // ここを [] に潰すと、選択中ラベルが localStorage から復元されている初回描画や
  // 取得失敗中に「選んだラベルは全部盤面に無い」という嘘を BoardFilterBar が
  // 出してしまう (bdboard-gxq5)。区別できる形のまま渡し、判定は受け手に任せる。
  const availableLabels = useMemo<string[] | undefined>(() => {
    const labels = new Set<string>();
    const data = boardQuery.data;
    if (data === undefined) {
      return undefined;
    }
    if (data.merged !== null) {
      collectBoardLabels(data.merged, labels);
    }
    for (const entry of data.projects) {
      collectBoardLabels(entry.board, labels);
    }
    // BoardFilterBar が同じ集合を compareStrings で並べ直すので、ここも明示的に
    // 同じコンパレータを使って desync のクラスごと消す。素の .sort() と
    // compareStrings は同じ < 意味論なので、これは挙動として no-op (bdboard-254q)。
    return [...labels].sort(compareStrings);
  }, [boardQuery.data]);

  const boardCardsById = useMemo(() => {
    const map = new Map<string, BoardCardDto>();
    const data = boardQuery.data;
    if (data === undefined) {
      return map;
    }
    if (data.merged !== null) {
      collectBoardCardsById(data.merged, map);
    }
    for (const entry of data.projects) {
      collectBoardCardsById(entry.board, map);
    }
    return map;
  }, [boardQuery.data]);

  return { boardQuery, boardTicketIds, availableLabels, boardCardsById };
}
