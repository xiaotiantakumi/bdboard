import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchAllAgentRuns } from '../api';

/**
 * bdboard-xuuz: 一括実行 (bdboard-mkm1.2) が「既に実行中のエージェントがある
 * カード」を対象外にするための、盤面全体の run 一覧取得。
 * useAllHarnessStatuses (useHarnessStatusData.ts) と同じ形: queryKey は固定
 * (呼び出し元が複数あっても同じキャッシュを共有する) で、`enabled` は呼び出し元
 * (useBulkAgentRun.ts) が選択があるときだけ true にする。取得に失敗しても
 * リトライしない — 「不明」として実行を止めない (最終判定はサーバーの
 * canStart / 409 already-running)。
 *
 * running / cancelling だけを「実行中」として拾う。サーバーの RunStore が
 * already-running と判定する条件 (record-helpers.ts の isActiveStatus) に揃えて
 * いる。
 */
export function useActiveAgentRuns(enabled: boolean) {
  const activeRunsQuery = useQuery({
    queryKey: ['agent-runs-active'],
    queryFn: fetchAllAgentRuns,
    enabled,
    retry: false,
  });

  const runningTicketIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of activeRunsQuery.data?.runs ?? []) {
      if (run.status === 'running' || run.status === 'cancelling') {
        ids.add(run.ticketId);
      }
    }
    return ids;
  }, [activeRunsQuery.data]);

  return { activeRunsQuery, runningTicketIds };
}
