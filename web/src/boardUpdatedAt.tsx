import { createContext, useContext } from 'react';
import { formatRelativeAge } from './boardFreshness';
import { useNow } from './hooks/useNow';

/** 盤面データを最後に取得できた時刻 (react-query の dataUpdatedAt)。未取得は null。 */
export const BoardUpdatedAtContext = createContext<number | null>(null);

/** 「N分前に更新」。1分未満は「たった今更新」。 */
export function formatUpdatedAgo(updatedAtMs: number, nowMs: number): string {
  const age = formatRelativeAge(updatedAtMs, nowMs);
  return age === 'たった今' ? 'たった今更新' : `${age}に更新`;
}

/** プロジェクト見出しの横に出す最終更新時刻。1 分ごとに更新する。 */
export function BoardUpdatedAtLabel() {
  const updatedAtMs = useContext(BoardUpdatedAtContext);
  const nowMs = useNow(60_000);
  if (updatedAtMs === null || updatedAtMs <= 0) return null;
  return <span className="board-updated-at">{formatUpdatedAgo(updatedAtMs, nowMs)}</span>;
}
