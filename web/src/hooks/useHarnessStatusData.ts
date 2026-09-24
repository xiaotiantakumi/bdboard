import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchAllHarnessStatus, type ProjectHarnessStatusDto } from '../api';

/**
 * bdboard-62p4 PR-3: App.tsx の `harness-status-all` クエリと、そこから導く
 * harnessStatuses マップを集約した。一括実行の前提判定 (bdboard-pkr6.11) 用。
 * 取得できなくても「不明」として扱い、ボタンは殺さない (最終判定はサーバーの
 * preflight) — これが `retry: false` の理由 (opus review finding #7 で元コメントの
 * この一文が抜けていた点を復元)。
 *
 * bdboard-mkm1.2: 一括操作バーの「▶ 実行」も同じ判定を使うので、取得条件を
 * `enabled` で受け取る版 (このフック) に切り出した。呼び出し元
 * (useBulkAgentRun.ts) は選択があるときだけ enabled にする。queryKey は
 * 固定なので、複数の呼び出し元がいても同じキャッシュを共有する。
 *
 * bdboard-mkm1.3: これを Next Up ビューを見ているときだけ enabled にする
 * `useHarnessStatusData(view)` ラッパーがあったが、Next Up ビュー削除に伴い
 * 削除した(唯一の呼び出し元だった NextUpView も削除済み)。
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
