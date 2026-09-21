// bdboard-sso1.48: SearchPalette.tsx の「クエリのデバウンス付きチケット検索」
// effect を、挙動を変えずにこのカスタムフックへ抽出しただけのファイル。
// ticketResults/isLoading/error の state 自体は SearchPalette.tsx 側で保持
// する (usePaletteRows の rows 算出でも読まれる共有 state のため。詳細は
// PR 本文の effect 順序表)。setState の setter はいずれも useState の直接の
// 戻り値であり React が参照安定を保証するため、依存配列に足しても毎レンダー
// effect が再発火することはない。
import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { searchTickets, type TicketSearchResultDto } from '../../api';

const DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 30;

export interface UseDebouncedTicketSearchOptions {
  hasQuery: boolean;
  trimmedQuery: string;
  setTicketResults: Dispatch<SetStateAction<TicketSearchResultDto[]>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<Error | null>>;
}

export function useDebouncedTicketSearch({
  hasQuery,
  trimmedQuery,
  setTicketResults,
  setIsLoading,
  setError,
}: UseDebouncedTicketSearchOptions): void {
  useEffect(() => {
    if (!hasQuery) {
      setTicketResults([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const handle = window.setTimeout(() => {
      void searchTickets(trimmedQuery, SEARCH_LIMIT)
        .then((hits) => {
          if (cancelled) return;
          setTicketResults(hits);
          setIsLoading(false);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setError(caught instanceof Error ? caught : new Error('検索に失敗しました'));
          setTicketResults([]);
          setIsLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [hasQuery, trimmedQuery, setTicketResults, setIsLoading, setError]);
}
