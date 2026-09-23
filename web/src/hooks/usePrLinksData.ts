import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { fetchPrLinks, type PrBadgeDto } from '../api';

/**
 * bdboard-62p4 PR-3: App.tsx の `pr-links` クエリ、そこから導く prLinksById、
 * および取得完了のたびに hygiene クエリを invalidate する useEffect を
 * 集約した。queryKey/queryFn/retry と useMemo/useEffect の依存配列・本体は
 * 元の App.tsx (旧 L282-295, L363-369) から1文字も変えていない。
 *
 * queryClient は元の App.tsx では `useQueryClient()` を App 内で1回だけ
 * 呼んで使い回していたが、ここではフック内で改めて `useQueryClient()` を
 * 呼ぶ。TanStack Query の QueryClientProvider から返るインスタンスは
 * 常に同一の安定した参照なので、呼び出し箇所が増えても実質的な挙動 (どの
 * QueryClient を使うか・invalidate の対象) は変わらない。
 */
export function usePrLinksData(
  selectedProjectIds: string[],
  selectedProjectIdsJoined: string,
) {
  const queryClient = useQueryClient();

  const prLinksQuery = useQuery({
    queryKey: ['pr-links', selectedProjectIdsJoined],
    queryFn: () => fetchPrLinks(selectedProjectIds),
    retry: false,
  });

  // PR バッジ用スキャンが close 証拠の唯一の走査元になったため、これが完了しても
  // hygiene 側からは分からない。手動で invalidate しないと、静かなボードでは初回表示が
  // 全件 unknown のまま SSE イベントまで解消しない (bdboard-pkr6.16 レビュー対応, m3)。
  useEffect(() => {
    if (prLinksQuery.dataUpdatedAt > 0) {
      void queryClient.invalidateQueries({ queryKey: ['hygiene'] });
    }
  }, [prLinksQuery.dataUpdatedAt, queryClient]);

  const prLinksById = useMemo(() => {
    const map = new Map<string, PrBadgeDto>();
    for (const badge of prLinksQuery.data ?? []) {
      map.set(badge.ticketId, badge);
    }
    return map;
  }, [prLinksQuery.data]);

  return { prLinksQuery, prLinksById };
}
