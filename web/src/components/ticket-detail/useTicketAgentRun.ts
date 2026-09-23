// bdboard-sso1.5 (PR-L): TicketDetailPanel.tsx の「エージェント実行 + ポーリング」
// (実行ボタン・確認ダイアログ・ハーネス前提の可視化・ポーリングによる状態表示・
// 中止・実行履歴の選択/取得) に関する state + query + mutation + effect 一式を、
// 挙動を変えずにこのカスタムフックへ抽出しただけのファイル。useTicketQuickActions
// と同じ抽出パターン (bdboard-sso1.5 PR-K)。
//
// agentRunActionsDisabled / quickActionsDisabled は元の実装ではクイックアクション
// 側の state (quickActions.confirmingQuickAction) にも依存しており、このフックは
// それを知らない (クイックアクションは PR-K で別フックへ抽出済み)。そのため
// confirmingAgentRun と startRunMutation.isPending はこのフックの戻り値として
// 個別に公開し、クイックアクション側の状態との合成は呼び出し元
// (TicketDetailPanel) 側の agentRunActionsDisabled / quickActionsDisabled で
// 行う — 元の実装がまさにこの2つの由来を1つの式で合成していたのと同じ形を、
// 呼び出し元で再現している。
//
// 「次に実行」コマンドのコピー (copyFeedback / handleCopyNextStep) は bd コマンド
// コピーと状態を共有する (useAutoClearedValue, bdboard-ty72) ため、このフックには
// 含めない。呼び出し元がそのまま表示コンポーネントへ props で渡す。
//
// ticketId/projectRootPath 変更時のリセットはこのフックが自前で持つ (Opus レビュー
// で指摘・修正: 元の実装では TicketDetailPanel 本体の1つの useEffect
// (`[ticketId, projectRootPath]`) が resetFormState 経由で全セクションをまとめて
// リセットしており、その宣言位置は「activeRunFromList → activeRunId」の同期
// useEffect より*前*だった。つまり「まずリセット、その後キャッシュ済みの実行中run
// で復元」という順序がソース上の宣言順で保証されていた。この関心事をフック化する
// と、フック呼び出し自体が親コンポーネント内で resetFormState の定義より前に来る
// (resetFormState が agentRun.reset を参照するため、agentRun の宣言が先でなければ
// ならない) ことにより、フック内部のeffectは常に親のリセットeffectより先に登録
// されるようになり、順序が逆転してしまう。結果として「['ticket-runs', ticketId]
// のキャッシュに実行中runが既にある状態で同じチケットを再訪した」ケースで、フック
// 内の同期effectがactiveRunIdを正しくセットした直後に、親のリセットeffectがそれを
// nullへ巻き戻し、ポーリングが一切始まらない (=実行中の表示が消える) という
// リグレッションを生んだ。
// 対策として、ticketId/projectRootPath 変更によるリセットをフック内部の
// useEffect として持たせ (下記)、その宣言順序を「activeRunFromList →
// activeRunId」の同期effectより前に固定する。こうすればフックがどこで呼ばれても
// (親のresetFormStateのタイミングに関係なく)、フック内部の2つのeffectだけで
// 元の「リセット→復元」の順序が保証される。親からの明示的な `agentRun.reset()`
// 呼び出しは廃止した (呼ぶと今回と同じ理由で再度上書きしてしまうため)。
// `reset` はテスト・将来の手動リセット用途のために戻り値として公開したまま。
//
// bdboard-sso1.79: ハーネス前提クエリ・実行履歴一覧クエリ・確認ダイアログの
// フォーカストラップ・履歴詳細クエリ・ポーリング effect・起動/中止 mutation を、
// それぞれ ./agent-run/*.ts へ move-only で抽出した (#618 useHygieneRepairActions /
// #623 useBulkActions と同じパターン)。ここに残るのは、複数の下位フックが共有する
// state (confirmingAgentRun/activeRunId/activeRunMeta/polledRunDetail/
// runStatusUnavailable/selectedHistoryRunId)、上記コメントの宣言順序が不変条件と
// なっている2つの useEffect (ticketId 変更リセット → activeRunFromList 同期)、
// それらに依存する hasActiveRun/runStartDisabled の算出、そして各下位フックを
// 呼び出して結果を束ねる配線。useState/useRef/useQuery/useMutation の呼び出し順は
// 分割前と同じ相対順序 (harness query → ticket-runs query → 6つの useState →
// 確認ダイアログの2つの useRef → reset用 useCallback → ticketIdリセット effect →
// 同期 effect → 履歴詳細 query → ポーリング effect → 起動/中止 mutation) を保って
// いる。
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentRunDetailDto, TicketDetailDto } from '../../api';
import { isAgentRunInProgress } from '../agentRunShared';
import { useAgentRunConfirmDialog } from './agent-run/useAgentRunConfirmDialog';
import { useAgentRunMutations } from './agent-run/useAgentRunMutations';
import { useAgentRunPolling } from './agent-run/useAgentRunPolling';
import { useHarnessRunBlockReason } from './agent-run/useHarnessRunBlockReason';
import { useSelectedHistoryRun } from './agent-run/useSelectedHistoryRun';
import { useTicketRunsQuery } from './agent-run/useTicketRunsQuery';
import { computeRunStartDisabled } from './agentRun';

export function useTicketAgentRun(
  ticketId: string,
  data: TicketDetailDto | undefined,
  projectRootPath: string | undefined,
) {
  const queryClient = useQueryClient();

  const harnessProjectId = data?.projectId;
  const harnessRunBlockReason = useHarnessRunBlockReason(harnessProjectId);

  const { ticketRunsData, ticketRunsLoading, ticketRunsError } =
    useTicketRunsQuery(ticketId);

  const [confirmingAgentRun, setConfirmingAgentRun] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunMeta, setActiveRunMeta] = useState<{
    worktreePath: string;
    branchName: string;
    reused: boolean;
  } | null>(null);
  const [polledRunDetail, setPolledRunDetail] = useState<AgentRunDetailDto | null>(
    null,
  );
  const [runStatusUnavailable, setRunStatusUnavailable] = useState(false);
  const [selectedHistoryRunId, setSelectedHistoryRunId] = useState<string | null>(
    null,
  );

  const { cancelAgentRunConfirmRef, agentRunConfirmRef, handleCancelAgentRun } =
    useAgentRunConfirmDialog(confirmingAgentRun, setConfirmingAgentRun);

  /**
   * ticketId/projectRootPath 切り替え時のフルリセット。手動呼び出し (テスト等)
   * にも使えるよう戻り値として公開しているが、本番コードから呼ぶのは直下の
   * ticketId 変更 effect のみ — 元は親 (resetFormState) から呼ばれていたが、
   * フック内の同期effectとの順序保証のためフック内部へ移した (ファイル冒頭の
   * コメント参照)。
   */
  const reset = useCallback(() => {
    setConfirmingAgentRun(false);
    setActiveRunId(null);
    setActiveRunMeta(null);
    setPolledRunDetail(null);
    setSelectedHistoryRunId(null);
  }, []);

  // このeffectは下の「activeRunFromList → activeRunId」同期effectより必ず前に
  // 宣言すること (順序がファイル冒頭の解説コメントの前提)。
  useEffect(() => {
    reset();
  }, [ticketId, projectRootPath, reset]);

  const activeRunFromList = useMemo(() => {
    return ticketRunsData?.runs.find((run) => isAgentRunInProgress(run.status));
  }, [ticketRunsData]);

  const hasActiveRun = useMemo(() => {
    if (runStatusUnavailable) {
      return false;
    }
    if (
      polledRunDetail !== null &&
      isAgentRunInProgress(polledRunDetail.status)
    ) {
      return true;
    }
    if (activeRunFromList !== undefined) {
      return true;
    }
    if (activeRunId !== null && polledRunDetail === null) {
      return true;
    }
    return false;
  }, [activeRunFromList, activeRunId, polledRunDetail, runStatusUnavailable]);

  const runStartDisabled = useMemo(() => {
    if (data === undefined) {
      return { disabled: true };
    }
    return computeRunStartDisabled(data, hasActiveRun);
  }, [data, hasActiveRun]);

  useEffect(() => {
    if (activeRunFromList === undefined) {
      return;
    }
    setActiveRunId(activeRunFromList.id);
  }, [activeRunFromList?.id, ticketId]);

  const { selectedHistoryRun, selectedHistoryRunLoading, selectedHistoryRunError } =
    useSelectedHistoryRun(selectedHistoryRunId);

  useAgentRunPolling(
    activeRunId,
    queryClient,
    ticketId,
    setPolledRunDetail,
    setRunStatusUnavailable,
  );

  const { startRunMutation, cancelRunMutation } = useAgentRunMutations(
    ticketId,
    queryClient,
    activeRunId,
    setConfirmingAgentRun,
    setActiveRunId,
    setActiveRunMeta,
  );

  return {
    confirmingAgentRun,
    setConfirmingAgentRun,
    harnessRunBlockReason,
    ticketRunsData,
    ticketRunsLoading,
    ticketRunsError,
    activeRunMeta,
    polledRunDetail,
    runStatusUnavailable,
    selectedHistoryRunId,
    setSelectedHistoryRunId,
    cancelAgentRunConfirmRef,
    agentRunConfirmRef,
    handleCancelAgentRun,
    hasActiveRun,
    runStartDisabled,
    selectedHistoryRun,
    selectedHistoryRunLoading,
    selectedHistoryRunError,
    startRunMutation,
    cancelRunMutation,
    reset,
  };
}
