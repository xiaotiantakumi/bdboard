// bdboard-sso1.74: HygienePanel.tsx の4クエリ(useQuery)+コピー用の
// useAutoClearedValue+useHygieneRepairActions+コピー用ハンドラを、挙動を変えずに
// このカスタムフックへ抽出しただけのファイル。呼び出し順序・依存配列・queryKey は
// 移動前から変えていない(query -> harnessDriftQuery -> leaseHealthQuery ->
// mergeSlotQuery -> useAutoClearedValue -> useHygieneRepairActions ->
// handleCopyCleanup の useCallback、の相対順序を保持)。
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { fetchHygiene, fetchLeaseHealth, fetchMergeSlotStatus } from '../../api';
import { copyTextToClipboard } from '../../bdCommands';
import { useAutoClearedValue } from '../../hooks/useAutoClearedValue';
import { COPY_FEEDBACK_MS } from './constants';
import { deriveHygienePanelState } from './deriveHygienePanelState';
import { fetchHarnessHygieneItems } from './harnessHygiene';
import { useHygieneRepairActions } from './useHygieneRepairActions';

export function useHygienePanel(projectIds: readonly string[]) {
  const projectIdsKey = projectIds.join(',');
  const query = useQuery({
    queryKey: ['hygiene', projectIdsKey],
    queryFn: () => fetchHygiene(projectIds),
  });
  const harnessDriftQuery = useQuery({
    queryKey: ['harness-drift', projectIdsKey],
    queryFn: () => fetchHarnessHygieneItems(projectIds),
  });
  const leaseHealthQuery = useQuery({
    queryKey: ['lease-health', projectIdsKey],
    queryFn: () => fetchLeaseHealth(projectIds),
  });
  const mergeSlotQuery = useQuery({
    queryKey: ['merge-slot-status', projectIdsKey],
    queryFn: () => fetchMergeSlotStatus(projectIds),
  });

  // bdboard-ty72: どちらの表示も await の継続から出る (コピーは
  // copyTextToClipboard、修復ステータスは invalidateQueries の後)。素の setTimeout
  // だとアンマウント後にタイマーを仕掛けうるので、useAutoClearedValue に任せる。
  const { value: ariaLiveMessage, show: showCopyMessage } = useAutoClearedValue(
    '',
    COPY_FEEDBACK_MS,
  );
  const repairActions = useHygieneRepairActions();

  const handleCopyCleanup = useCallback(
    async (script: string) => {
      try {
        await copyTextToClipboard(script);
        showCopyMessage('掃除コマンドをコピーしました');
      } catch (copyError) {
        console.error('Failed to copy worktree cleanup commands', copyError);
        showCopyMessage('コピーできませんでした');
      }
    },
    [showCopyMessage],
  );

  const derived = deriveHygienePanelState(
    query,
    harnessDriftQuery,
    leaseHealthQuery,
    mergeSlotQuery,
    projectIds,
    repairActions.bulkUpdateTargets,
    repairActions.bulkUpdateSummary,
  );

  return {
    ariaLiveMessage,
    handleCopyCleanup,
    ...repairActions,
    ...derived,
  };
}
