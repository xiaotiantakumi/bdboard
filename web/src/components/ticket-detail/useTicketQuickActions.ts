// bdboard-sso1.5 (PR-K): TicketDetailPanel.tsx の「クイックアクション」
// (着手/完了/延期/優先度変更とその確認ダイアログ) に関する state + focus trap +
// mutation + handler 一式を、挙動を変えずにこのカスタムフックへ抽出しただけの
// ファイル。useTicketDependencies / useTicketLabels と同じ抽出パターン。
//
// quickActionsDisabled は元の実装ではエージェント実行側の state
// (confirmingAgentRun / startRunMutation.isPending) にも依存しており、この
// フックはそれらを知らない (エージェント実行はこのチケットの別セクションで、
// 今回は対象外)。そのため mutationPending と confirmingQuickAction はこの
// フックの戻り値として個別に公開し、エージェント実行側の状態との合成は
// 呼び出し元 (TicketDetailPanel) 側の quickActionsDisabled で行う — 元の
// 実装がまさにこの2つの由来 (quick-action 側 / agent-run 側) を1つの式で
// 合成していたのと同じ形を、呼び出し元で再現している。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState, type RefObject } from 'react';
import {
  postTicketQuickAction,
  postTicketQuickActionUndo,
  type QuickActionRequest,
} from '../../api';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { planQuickActionUndo } from '../../quickActionUndo';
import {
  computeDeferUntilDate,
  DEFAULT_DEFER_PERIOD,
  isFutureLocalDate,
  type DeferPeriodKind,
} from '../../deferPeriods';
import { useUndoSnackbar } from '../UndoSnackbar';
import { toQuickActionRequest } from './quickActionConfirm';
import type { ConfirmingQuickAction } from './types';

/** quickActionMutation / canRaisePriority / canLowerPriority が参照する data の
 * 最小形。TicketDetailDto はこれを満たすので、呼び出し側は data をそのまま
 * 渡せる。 */
export interface TicketQuickActionsSourceData {
  readonly priority: number;
}

export interface TicketQuickActionsEditing {
  readonly confirmingQuickAction: ConfirmingQuickAction | null;
  readonly setConfirmingQuickAction: (
    action: ConfirmingQuickAction | null,
  ) => void;
  readonly quickActionConfirmRef: RefObject<HTMLDivElement | null>;
  readonly cancelQuickActionRef: RefObject<HTMLButtonElement | null>;
  readonly deferPeriodKind: DeferPeriodKind;
  readonly setDeferPeriodKind: (kind: DeferPeriodKind) => void;
  readonly customDeferDate: string;
  readonly setCustomDeferDate: (value: string) => void;
  readonly closeReason: string;
  readonly setCloseReason: (value: string) => void;
  readonly canRaisePriority: boolean;
  readonly canLowerPriority: boolean;
  readonly deferSubmitDisabled: boolean;
  readonly mutationPending: boolean;
  readonly mutationError: unknown;
  readonly handleCancelQuickAction: () => void;
  readonly handleConfirmQuickAction: () => void;
  readonly handleDeferQuickAction: () => void;
  /** ticketId 切り替え時のフルリセット (resetFormState から呼ぶ)。 */
  readonly reset: () => void;
}

export function useTicketQuickActions(
  ticketId: string,
  data: TicketQuickActionsSourceData | undefined,
  undoSnackbar: ReturnType<typeof useUndoSnackbar>,
): TicketQuickActionsEditing {
  const queryClient = useQueryClient();
  const [confirmingQuickAction, setConfirmingQuickAction] =
    useState<ConfirmingQuickAction | null>(null);
  const [deferPeriodKind, setDeferPeriodKind] =
    useState<DeferPeriodKind>(DEFAULT_DEFER_PERIOD);
  const [customDeferDate, setCustomDeferDate] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const cancelQuickActionRef = useRef<HTMLButtonElement>(null);
  const quickActionConfirmRef = useRef<HTMLDivElement>(null);

  const handleCancelQuickAction = useCallback(() => {
    setConfirmingQuickAction(null);
    setDeferPeriodKind(DEFAULT_DEFER_PERIOD);
    setCustomDeferDate('');
    setCloseReason('');
  }, []);

  useFocusTrap({
    containerRef: quickActionConfirmRef,
    initialFocusRef: cancelQuickActionRef,
    enabled: confirmingQuickAction !== null,
    onEscape: handleCancelQuickAction,
  });

  const quickActionMutation = useMutation({
    mutationFn: async (vars: {
      request: QuickActionRequest;
      previousPriority?: number;
    }) => {
      await postTicketQuickAction(ticketId, vars.request);
      return vars;
    },
    onSuccess: async (vars) => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setConfirmingQuickAction(null);
      setCloseReason('');

      // 誤操作からの復帰用にUndoスナックバーを出す(bdboard-3tw.69: 確認ダイアログの
      // 代わりの事後Undo)。priority は実行前の値(vars.previousPriority)を
      // handleConfirmQuickAction 側で確定当時の data.priority から渡している。
      const plan = planQuickActionUndo(vars.request, vars.previousPriority);
      if (plan !== null) {
        undoSnackbar?.showUndo({
          message: plan.message,
          onUndo: async () => {
            await postTicketQuickActionUndo(ticketId, plan.undoRequest);
            await queryClient.invalidateQueries({
              queryKey: ['ticket', ticketId],
            });
            await queryClient.invalidateQueries({ queryKey: ['board'] });
          },
        });
      }
    },
  });

  const handleConfirmQuickAction = useCallback(() => {
    if (confirmingQuickAction === null) {
      return;
    }

    quickActionMutation.mutate({
      request: toQuickActionRequest(confirmingQuickAction, closeReason),
      // priority のUndoは「実行前の値へ戻す」ため、確定操作の時点(=まだ古い値を
      // 表示している data)から previousPriority を採取する。invalidate 後に
      // data.priority を読むと新しい値になってしまうため、ここで確定させる。
      ...(confirmingQuickAction.kind === 'priority' && data !== undefined
        ? { previousPriority: data.priority }
        : {}),
    });
  }, [closeReason, confirmingQuickAction, data, quickActionMutation]);

  const canRaisePriority = data !== undefined && data.priority > 0;
  const canLowerPriority = data !== undefined && data.priority < 4;
  const deferSubmitDisabled =
    deferPeriodKind === 'custom' && !isFutureLocalDate(customDeferDate);

  const handleDeferQuickAction = useCallback(() => {
    const untilDate =
      deferPeriodKind === 'custom'
        ? customDeferDate
        : computeDeferUntilDate(deferPeriodKind);
    setConfirmingQuickAction({ kind: 'defer', untilDate });
  }, [customDeferDate, deferPeriodKind]);

  const reset = useCallback(() => {
    setConfirmingQuickAction(null);
    setDeferPeriodKind(DEFAULT_DEFER_PERIOD);
    setCustomDeferDate('');
    setCloseReason('');
  }, []);

  return {
    confirmingQuickAction,
    setConfirmingQuickAction,
    quickActionConfirmRef,
    cancelQuickActionRef,
    deferPeriodKind,
    setDeferPeriodKind,
    customDeferDate,
    setCustomDeferDate,
    closeReason,
    setCloseReason,
    canRaisePriority,
    canLowerPriority,
    deferSubmitDisabled,
    mutationPending: quickActionMutation.isPending,
    mutationError: quickActionMutation.error,
    handleCancelQuickAction,
    handleConfirmQuickAction,
    handleDeferQuickAction,
    reset,
  };
}
