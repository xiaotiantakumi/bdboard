import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchAllHarnessStatus, type ProjectHarnessStatusDto } from '../api';
import type { ViewMode } from '../uiPersistedState';

/**
 * bdboard-62p4 PR-3: App.tsx の `harness-status-all` クエリと、そこから導く
 * harnessStatuses マップを集約した。queryKey/queryFn/enabled/retry と
 * useMemo の依存配列・本体は元の App.tsx (旧 L317-330) から1文字も
 * 変えていない。一括実行の前提判定 (bdboard-pkr6.11) 用で、Next Up を
 * 見ているときだけ引く — 判定に使うのはそのビューのボタンだけで、他の
 * ビューでは注入先の `.claude/` を読ませる理由が無い。
 */
export function useHarnessStatusData(view: ViewMode) {
  const harnessStatusQuery = useQuery({
    queryKey: ['harness-status-all'],
    queryFn: fetchAllHarnessStatus,
    enabled: view === 'next',
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
