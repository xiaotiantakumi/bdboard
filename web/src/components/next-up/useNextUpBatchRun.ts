// bdboard-sso1.43: NextUpView.tsx の一括実行 (▶ 一括実行 / 確認 / 停止) まわりの
// state・memo・callback をカスタムフックへ移動しただけ。move-only 抽出。
// フックの呼び出し順・依存配列・共有 ref の関係は移動前から変えていない。
// useFocusTrap 自体は TunnelControl.tsx の publish フローと同じく親
// (NextUpView) に残し、このフックは containerRef/initialFocusRef/enabled/
// onEscape に渡す値だけを返す。
import { type RefObject, useCallback, useMemo, useRef, useState } from 'react';
import {
  type BoardDto,
  type ProjectHarnessStatusDto,
  projectNameFallback,
} from '../../api';
import { describeHarnessRunBlock } from '../agentRunShared';
import type {
  NextUpLoopPhase,
  NextUpLoopProgress,
  NextUpRunLoopController,
} from '../nextUpRunLoop';

export interface UseNextUpBatchRunParams {
  visibleRegularCards: BoardDto['lanes']['ready'];
  projectNames: Map<string, string>;
  harnessStatuses?: ReadonlyMap<string, ProjectHarnessStatusDto>;
  batchRun: NextUpRunLoopController;
}

export interface NextUpBatchRunState {
  loopPhase: NextUpLoopPhase;
  loopProgress: NextUpLoopProgress;
  harnessBlockReason: string | null;
  pendingBatchTicketIds: readonly string[] | null;
  batchRunConfirmRef: RefObject<HTMLDivElement | null>;
  cancelBatchRunConfirmRef: RefObject<HTMLButtonElement | null>;
  handleOpenBatchRunConfirm: () => void;
  handleCancelBatchRunConfirm: () => void;
  handleConfirmBatchRun: () => void;
  handleStopLoop: () => void;
}

export function useNextUpBatchRun({
  visibleRegularCards,
  projectNames,
  harnessStatuses,
  batchRun,
}: UseNextUpBatchRunParams): NextUpBatchRunState {
  const [pendingBatchTicketIds, setPendingBatchTicketIds] = useState<
    readonly string[] | null
  >(null);
  const batchRunConfirmRef = useRef<HTMLDivElement>(null);
  const cancelBatchRunConfirmRef = useRef<HTMLButtonElement>(null);
  const loopPhase = batchRun.phase;
  const loopProgress = batchRun.progress;

  /**
   * 一括実行は複数プロジェクトにまたがりうるので、対象カードのプロジェクトを
   * 1 つでも前提未達なら止める — そのチケットに来た時点でサーバーが 409 を返し、
   * 連続失敗でバッチ自体が停止するため、走らせても最後まで行かない。
   * どのプロジェクトかが分からないと直せないので、理由には名前を添える。
   */
  const harnessBlockReason = useMemo(() => {
    if (harnessStatuses === undefined) {
      return null;
    }
    for (const card of visibleRegularCards) {
      const reason = describeHarnessRunBlock(harnessStatuses.get(card.projectId));
      if (reason !== null) {
        const name =
          projectNames.get(card.projectId) ?? projectNameFallback(card.projectId);
        return `${name}: ${reason}`;
      }
    }
    return null;
  }, [harnessStatuses, projectNames, visibleRegularCards]);

  const handleOpenBatchRunConfirm = useCallback(() => {
    if (
      loopPhase !== 'idle' ||
      visibleRegularCards.length === 0 ||
      harnessBlockReason !== null
    ) {
      return;
    }
    setPendingBatchTicketIds(
      visibleRegularCards.map((card) => card.ticket.id),
    );
  }, [harnessBlockReason, loopPhase, visibleRegularCards]);

  const handleCancelBatchRunConfirm = useCallback(() => {
    setPendingBatchTicketIds(null);
  }, []);

  const handleConfirmBatchRun = useCallback(() => {
    const ticketIds = pendingBatchTicketIds;
    setPendingBatchTicketIds(null);
    if (ticketIds !== null) {
      batchRun.beginBatchRun(ticketIds);
    }
  }, [batchRun, pendingBatchTicketIds]);

  const handleStopLoop = useCallback(() => {
    // Do not call cancelAgentRun here: the server-side run keeps going.
    // Stopping means the batch loop will not advance to the next ticket and
    // will stop polling progress, returning to idle immediately. To actually
    // cancel the in-flight run, use TicketDetailPanel's per-run cancel button.
    batchRun.stopBatchRun();
  }, [batchRun]);

  return {
    loopPhase,
    loopProgress,
    harnessBlockReason,
    pendingBatchTicketIds,
    batchRunConfirmRef,
    cancelBatchRunConfirmRef,
    handleOpenBatchRunConfirm,
    handleCancelBatchRunConfirm,
    handleConfirmBatchRun,
    handleStopLoop,
  };
}
