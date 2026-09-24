import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchAllHarnessStatus, type ProjectHarnessStatusDto } from '../api';
import type { ViewMode } from '../uiPersistedState';

/**
 * bdboard-62p4 PR-3: App.tsx の `harness-status-all` クエリと、そこから導く
 * harnessStatuses マップを集約した。一括実行の前提判定 (bdboard-pkr6.11) 用。
 * 取得できなくても「不明」として扱い、ボタンは殺さない (最終判定はサーバーの
 * preflight) — これが `retry: false` の理由 (opus review finding #7 で元コメントの
 * この一文が抜けていた点を復元)。
 *
 * bdboard-mkm1.2: 一括操作バーの「▶ 実行」も同じ判定を使うので、取得条件を
 * `enabled` で受け取る版 (useAllHarnessStatuses) に切り出した。queryKey が同じなので
 * Next Up と一括操作バーでキャッシュを共有する。注入先の `.claude/` を読ませるのは
 * 判定が要るとき (Next Up を見ている / カードを選択している) だけ。
 */
export function useAllHarnessStatuses(enabled: boolean) {
  const harnessStatusQuery = useQuery({
    queryKey: ['harness-status-all'],
    queryFn: fetchAllHarnessStatus,
    enabled,
    retry: false,
  });

  const harnessStatuses = useMemo(() => {
    const map = new Map<string, ProjectHarnessStatusDto>();
    for (const entry of harnessStatusQuery.data?.projects ?? []) {
      map.set(entry.projectId, { packs: entry.packs, contract: entry.contract });
    }
    return map;
  }, [harnessStatusQuery.data]);

  return { harnessStatusQuery, harnessStatuses };
}

/** Next Up を見ているときだけ引く (判定に使うのはそのビューの「▶ 一括実行」)。 */
export function useHarnessStatusData(view: ViewMode) {
  return useAllHarnessStatuses(view === 'next');
}
