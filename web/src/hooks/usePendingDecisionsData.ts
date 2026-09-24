import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchPendingDecisions, type PendingDecisionDto } from '../api';
import { useAppBadge } from './useAppBadge';

/**
 * bdboard-62p4 PR-3: App.tsx の `pending-decisions` クエリ、そこから導く
 * pendingDecisionsById/pendingDecisionIds、および件数をアプリバッジへ反映する
 * useAppBadge 呼び出しを集約した。queryKey/queryFn と各 useMemo の依存配列・
 * 本体、useAppBadge への引数は元の App.tsx (旧 L277-280, L297, L351-361) から
 * 1文字も変えていない。
 *
 * 呼び出し順の注記: 元の App.tsx では useAppBadge(...) は prLinksQuery の
 * hygiene invalidate effect (旧 L288-295) より後 (旧 L297) に呼ばれていたが、
 * ここでは pendingDecisionsQuery の直後に呼ぶ。useAppBadge は自分の引数
 * (pendingDecisionsQuery.data?.length) だけに依存する独立した副作用
 * (navigator.setAppBadge) で、prLinksQuery 側の状態を読み書きしないため、
 * 呼び出し位置がずれても発火するタイミング・内容は変わらない。
 */
export function usePendingDecisionsData() {
  const pendingDecisionsQuery = useQuery({
    queryKey: ['pending-decisions'],
    queryFn: fetchPendingDecisions,
  });

  useAppBadge(pendingDecisionsQuery.data?.length);

  const pendingDecisionsById = useMemo(() => {
    const map = new Map<string, PendingDecisionDto>();
    for (const decision of pendingDecisionsQuery.data ?? []) {
      map.set(decision.id, decision);
    }
    return map;
  }, [pendingDecisionsQuery.data]);

  const pendingDecisionIds = useMemo(() => {
    return new Set(pendingDecisionsById.keys());
  }, [pendingDecisionsById]);

  return { pendingDecisionsQuery, pendingDecisionsById, pendingDecisionIds };
}
