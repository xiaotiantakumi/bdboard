// bdboard-sso1.11 PR-C: HygienePanel.tsx の「行の修復 (undefer/close/ハーネス
// 再注入/検証コントラクトのチケット起票/ハーネス一括更新)」に関する state +
// mutation + handler 一式を、挙動を変えずにこのカスタムフックへ抽出しただけの
// ファイル。SettingsPanel.tsx の useAiQuotaAlertForm / useAgentRunsForm
// (bdboard-sso1.10 PR-D) と同じ抽出パターン。呼び出し順序・依存配列・
// queryKey・onSuccess/onError の中身は移動前から変えていない。
//
// bdboard-sso1.55: 4つの mutation (repair/harness inject/harness bulk update/
// contract ticket) をそれぞれ関心別フック (./repair-actions/*.ts) へ move-only で
// 抽出した。ここに残るのは、複数の mutation が共有するフィードバック state
// (confirmingRepairKey/pendingRepairKey/repairError/repairStatusMessage/
// bulkUpdateTargets/bulkUpdateSummary) と、各フックを呼び出して結果を束ねる配線。
// useMutation/useQueryClient の呼び出し順は分割前と同じ相対順序
// (repairMutation → harnessInjectMutation → harnessBulkUpdateMutation →
// contractTicketMutation) を保っている。
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type RefObject } from 'react';
import type { HygieneIssueDto } from '../../api';
import type {
  HarnessBulkUpdateSummary,
  HarnessBulkUpdateTarget,
} from '../../harnessBulkUpdate';
import { useAutoClearedValue } from '../../hooks/useAutoClearedValue';
import { useUndoSnackbar } from '../UndoSnackbar';
import { REPAIR_FEEDBACK_MS } from './constants';
import { useContractTicketRepair } from './repair-actions/useContractTicketRepair';
import { useHarnessBulkUpdate } from './repair-actions/useHarnessBulkUpdate';
import { useHarnessInjectRepair } from './repair-actions/useHarnessInjectRepair';
import { useSingleTicketRepair } from './repair-actions/useSingleTicketRepair';
import type { HarnessContractItem, HarnessPackItem, RepairFeedback } from './types';

export interface HygieneRepairActions {
  readonly repairStatusMessage: string;
  readonly repairDisabled: boolean;
  readonly confirmingRepairKey: string | null;
  readonly pendingRepairKey: string | null;
  readonly repairError: RepairFeedback | null;
  readonly bulkUpdateTargets: readonly HarnessBulkUpdateTarget[] | null;
  readonly bulkUpdateSummary: HarnessBulkUpdateSummary | null;
  readonly isBulkUpdating: boolean;
  readonly bulkConfirmButtonRef: RefObject<HTMLButtonElement | null>;
  readonly beginRepairConfirm: (rowKey: string) => void;
  readonly cancelRepairConfirm: () => void;
  readonly handleConfirmRepair: (issue: HygieneIssueDto, rowKey: string) => void;
  readonly handleConfirmHarnessUpdate: (item: HarnessPackItem, rowKey: string) => void;
  readonly handleConfirmContractTicket: (item: HarnessContractItem, rowKey: string) => void;
  readonly beginBulkUpdateConfirm: (items: readonly HarnessPackItem[]) => void;
  readonly confirmBulkUpdate: () => void;
  readonly cancelBulkUpdateTargets: () => void;
  readonly closeBulkUpdateSummary: () => void;
}

export function useHygieneRepairActions(): HygieneRepairActions {
  const queryClient = useQueryClient();
  const undoSnackbar = useUndoSnackbar();

  const {
    value: repairStatusMessage,
    show: showRepairStatusMessage,
    clear: clearRepairStatusMessage,
  } = useAutoClearedValue('', REPAIR_FEEDBACK_MS);
  const [confirmingRepairKey, setConfirmingRepairKey] = useState<string | null>(
    null,
  );
  const [pendingRepairKey, setPendingRepairKey] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<RepairFeedback | null>(null);
  const [bulkUpdateTargets, setBulkUpdateTargets] = useState<
    readonly HarnessBulkUpdateTarget[] | null
  >(null);
  const [bulkUpdateSummary, setBulkUpdateSummary] =
    useState<HarnessBulkUpdateSummary | null>(null);

  const clearRepairFeedback = useCallback(() => {
    setRepairError(null);
    clearRepairStatusMessage();
  }, [clearRepairStatusMessage]);

  const beginRepairConfirm = useCallback(
    (rowKey: string) => {
      setConfirmingRepairKey(rowKey);
      // 確認欄は同時に1つだけ開く (一括更新の確認も閉じる)。
      setBulkUpdateTargets(null);
      clearRepairFeedback();
    },
    [clearRepairFeedback],
  );

  const { repairMutation, handleConfirmRepair } = useSingleTicketRepair({
    queryClient,
    undoSnackbar,
    clearRepairFeedback,
    showRepairStatusMessage,
    setPendingRepairKey,
    setConfirmingRepairKey,
    setRepairError,
  });

  const { harnessInjectMutation, handleConfirmHarnessUpdate } =
    useHarnessInjectRepair({
      queryClient,
      clearRepairFeedback,
      showRepairStatusMessage,
      setPendingRepairKey,
      setConfirmingRepairKey,
      setRepairError,
      setBulkUpdateSummary,
      repairPending: repairMutation.isPending,
    });

  const {
    harnessBulkUpdateMutation,
    beginBulkUpdateConfirm,
    confirmBulkUpdate,
    cancelBulkUpdateTargets,
    closeBulkUpdateSummary,
    bulkConfirmButtonRef,
  } = useHarnessBulkUpdate({
    queryClient,
    clearRepairFeedback,
    showRepairStatusMessage,
    setConfirmingRepairKey,
    bulkUpdateTargets,
    setBulkUpdateTargets,
    setBulkUpdateSummary,
  });

  const { contractTicketMutation, handleConfirmContractTicket } =
    useContractTicketRepair({
      queryClient,
      clearRepairFeedback,
      showRepairStatusMessage,
      setPendingRepairKey,
      setConfirmingRepairKey,
      setRepairError,
      setBulkUpdateSummary,
    });

  const repairDisabled =
    repairMutation.isPending ||
    harnessInjectMutation.isPending ||
    harnessBulkUpdateMutation.isPending ||
    contractTicketMutation.isPending;

  const cancelRepairConfirm = useCallback(() => {
    setConfirmingRepairKey(null);
  }, []);

  return {
    repairStatusMessage,
    repairDisabled,
    confirmingRepairKey,
    pendingRepairKey,
    repairError,
    bulkUpdateTargets,
    bulkUpdateSummary,
    isBulkUpdating: harnessBulkUpdateMutation.isPending,
    bulkConfirmButtonRef,
    beginRepairConfirm,
    cancelRepairConfirm,
    handleConfirmRepair,
    handleConfirmHarnessUpdate,
    handleConfirmContractTicket,
    beginBulkUpdateConfirm,
    confirmBulkUpdate,
    cancelBulkUpdateTargets,
    closeBulkUpdateSummary,
  };
}
