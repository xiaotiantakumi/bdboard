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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelAgentRun,
  fetchAgentRun,
  fetchProjectHarnessStatus,
  fetchTicketRuns,
  startTicketRun,
  type AgentRunDetailDto,
  type TicketDetailDto,
} from '../../api';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
  AGENT_RUN_POLL_INTERVAL_MS,
  AGENT_RUN_POLL_MAX_FAILURES,
  describeHarnessRunBlock,
  isAgentRunInProgress,
} from '../agentRunShared';
import { computeRunStartDisabled } from './agentRun';

export function useTicketAgentRun(
  ticketId: string,
  data: TicketDetailDto | undefined,
  projectRootPath: string | undefined,
) {
  const queryClient = useQueryClient();

  // エージェント実行の前提 (bdboard-pkr6.11)。ProjectHarnessBadges と同じ
  // queryKey なので、同じプロジェクトを表示中なら取得は 1 回に畳まれる。
  const harnessProjectId = data?.projectId;
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
  const harnessRunBlockReason = describeHarnessRunBlock(harnessStatus);

  const {
    data: ticketRunsData,
    isLoading: ticketRunsLoading,
    error: ticketRunsError,
  } = useQuery({
    queryKey: ['ticket-runs', ticketId],
    queryFn: () => fetchTicketRuns(ticketId),
  });

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

  const cancelAgentRunConfirmRef = useRef<HTMLButtonElement>(null);
  const agentRunConfirmRef = useRef<HTMLDivElement>(null);

  const handleCancelAgentRun = useCallback(() => {
    setConfirmingAgentRun(false);
  }, []);

  useFocusTrap({
    containerRef: agentRunConfirmRef,
    initialFocusRef: cancelAgentRunConfirmRef,
    enabled: confirmingAgentRun,
    onEscape: handleCancelAgentRun,
  });

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

  const {
    data: selectedHistoryRun,
    isLoading: selectedHistoryRunLoading,
    error: selectedHistoryRunError,
  } = useQuery({
    queryKey: ['agent-run', selectedHistoryRunId],
    queryFn: () => fetchAgentRun(selectedHistoryRunId!),
    enabled: selectedHistoryRunId !== null,
  });

  useEffect(() => {
    if (activeRunId === null) {
      setPolledRunDetail(null);
      setRunStatusUnavailable(false);
      return;
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let consecutiveFailures = 0;

    setRunStatusUnavailable(false);
    consecutiveFailures = 0;

    const poll = async (): Promise<AgentRunDetailDto | null> => {
      try {
        const detail = await fetchAgentRun(activeRunId);
        if (cancelled) {
          return null;
        }
        consecutiveFailures = 0;
        setRunStatusUnavailable(false);
        setPolledRunDetail(detail);
        if (!isAgentRunInProgress(detail.status)) {
          void queryClient.invalidateQueries({
            queryKey: ['ticket-runs', ticketId],
          });
        }
        return detail;
      } catch (pollError) {
        console.error('Failed to poll agent run', pollError);
        if (cancelled) {
          return null;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= AGENT_RUN_POLL_MAX_FAILURES) {
          setRunStatusUnavailable(true);
          if (intervalId !== undefined) {
            clearInterval(intervalId);
            intervalId = undefined;
          }
        }
        return null;
      }
    };

    void (async () => {
      const initialDetail = await poll();
      if (cancelled || consecutiveFailures >= AGENT_RUN_POLL_MAX_FAILURES) {
        return;
      }
      if (
        initialDetail !== null &&
        !isAgentRunInProgress(initialDetail.status)
      ) {
        return;
      }

      intervalId = setInterval(() => {
        void (async () => {
          const detail = await poll();
          if (cancelled || consecutiveFailures >= AGENT_RUN_POLL_MAX_FAILURES) {
            return;
          }
          if (
            detail !== null &&
            !isAgentRunInProgress(detail.status) &&
            intervalId !== undefined
          ) {
            clearInterval(intervalId);
            intervalId = undefined;
          }
        })();
      }, AGENT_RUN_POLL_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
      }
    };
  }, [activeRunId, queryClient, ticketId]);

  const startRunMutation = useMutation({
    mutationFn: () => startTicketRun(ticketId),
    onSuccess: (response) => {
      setConfirmingAgentRun(false);
      setActiveRunId(response.runId);
      setActiveRunMeta({
        worktreePath: response.worktreePath,
        branchName: response.branchName,
        reused: response.reused,
      });
      void queryClient.invalidateQueries({ queryKey: ['ticket-runs', ticketId] });
    },
  });

  const cancelRunMutation = useMutation({
    mutationFn: async () => {
      if (activeRunId === null) {
        throw new Error('active run is not available');
      }
      await cancelAgentRun(activeRunId);
    },
  });

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
