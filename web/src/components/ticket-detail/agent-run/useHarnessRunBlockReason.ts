// bdboard-sso1.79: useTicketAgentRun.ts から、エージェント実行前提のハーネス状態
// 取得 (ProjectHarnessBadges と同じ queryKey) + harnessRunBlockReason の算出を
// move-only で切り出したフック。クエリの中身・queryKey・retry設定は移動前から
// 変えていない。
import { useQuery } from '@tanstack/react-query';
import { fetchProjectHarnessStatus } from '../../../api';
import { describeHarnessRunBlock } from '../../agentRunShared';

export function useHarnessRunBlockReason(harnessProjectId: string | undefined) {
  // エージェント実行の前提 (bdboard-pkr6.11)。ProjectHarnessBadges と同じ
  // queryKey なので、同じプロジェクトを表示中なら取得は 1 回に畳まれる。
  const { data: harnessStatus } = useQuery({
    queryKey: ['project-harness', harnessProjectId],
    queryFn: () => {
      if (harnessProjectId === undefined) {
        throw new Error('project id is required');
      }
      return fetchProjectHarnessStatus(harnessProjectId);
    },
    enabled: harnessProjectId !== undefined,
    // 前提の可視化が目的なので、落ちたら黙って未取得のまま (= ブロックしない)。
    // リトライで詳細パネルを開くたびに 3 回叩く価値は無い。
    retry: false,
  });

  return describeHarnessRunBlock(harnessStatus);
}
