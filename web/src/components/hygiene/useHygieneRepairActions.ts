// bdboard-sso1.11 PR-C: HygienePanel.tsx の「行の修復 (undefer/close/ハーネス
// 再注入/検証コントラクトのチケット起票/ハーネス一括更新)」に関する state +
// mutation + handler 一式を、挙動を変えずにこのカスタムフックへ抽出しただけの
// ファイル。SettingsPanel.tsx の useAiQuotaAlertForm / useAgentRunsForm
// (bdboard-sso1.10 PR-D) と同じ抽出パターン。呼び出し順序・依存配列・
// queryKey・onSuccess/onError の中身は移動前から変えていない。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { HygieneIssueDto, ProjectHarnessPackStatusDto, QuickActionRequest } from '../../api';
import {
  postProjectHarnessContractTicket,
  postProjectHarnessInject,
  postTicketQuickAction,
  postTicketQuickActionUndo,
} from '../../api';
import { buildHarnessContractTicketSuccessMessage, buildHarnessInjectSuccessMessage } from '../../harnessDisplay';
import { useAutoClearedValue } from '../../hooks/useAutoClearedValue';
import { planQuickActionUndo } from '../../quickActionUndo';
import { describeWriteError } from '../../writeAccessMessage';
import {
  buildHarnessBulkSummaryMessage,
  runHarnessBulkUpdate,
  type HarnessBulkUpdateSummary,
  type HarnessBulkUpdateTarget,
} from '../../harnessBulkUpdate';
import { useUndoSnackbar } from '../UndoSnackbar';
import { REPAIR_FEEDBACK_MS } from './constants';
import { buildRepairRequest, buildRepairSuccessMessage } from './issueDisplay';
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

  const repairMutation = useMutation({
    mutationFn: async (vars: {
      rowKey: string;
      ticketId: string;
      request: QuickActionRequest;
      previousDeferUntil?: string;
    }) => {
      await postTicketQuickAction(vars.ticketId, vars.request);
      return vars;
    },
    onMutate: (vars) => {
      setPendingRepairKey(vars.rowKey);
      clearRepairFeedback();
    },
    onSuccess: async (vars) => {
      await queryClient.invalidateQueries({ queryKey: ['hygiene'] });
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setConfirmingRepairKey(null);
      setPendingRepairKey(null);

      showRepairStatusMessage(
        buildRepairSuccessMessage(vars.request, vars.ticketId),
      );

      const plan = planQuickActionUndo(
        vars.request,
        undefined,
        vars.previousDeferUntil,
      );
      if (plan !== null) {
        undoSnackbar?.showUndo({
          message: plan.message,
          onUndo: async () => {
            await postTicketQuickActionUndo(vars.ticketId, plan.undoRequest);
            await queryClient.invalidateQueries({ queryKey: ['hygiene'] });
            await queryClient.invalidateQueries({ queryKey: ['board'] });
          },
        });
      }
    },
    onError: (error, vars) => {
      setPendingRepairKey(null);
      setRepairError({
        rowKey: vars.rowKey,
        message: describeWriteError(error, '修復を実行できませんでした'),
      });
    },
  });

  const harnessInjectMutation = useMutation({
    mutationFn: async (vars: {
      rowKey: string;
      projectId: string;
      pack: ProjectHarnessPackStatusDto;
    }) => {
      await postProjectHarnessInject(vars.projectId, vars.pack.name);
      return vars;
    },
    onMutate: (vars) => {
      setPendingRepairKey(vars.rowKey);
      clearRepairFeedback();
    },
    onSuccess: async (vars) => {
      await queryClient.invalidateQueries({ queryKey: ['harness-drift'] });
      await queryClient.invalidateQueries({
        queryKey: ['project-harness', vars.projectId],
      });
      setConfirmingRepairKey(null);
      setPendingRepairKey(null);
      // 単体で直した後に古い一括結果 (「失敗」行など) を残さない。
      setBulkUpdateSummary(null);
      showRepairStatusMessage(
        buildHarnessInjectSuccessMessage(vars.pack.name, vars.pack),
      );
    },
    onError: (error, vars) => {
      setPendingRepairKey(null);
      setRepairError({
        rowKey: vars.rowKey,
        message: describeWriteError(error, 'ハーネスの更新に失敗しました'),
      });
    },
  });

  const harnessBulkUpdateMutation = useMutation({
    mutationFn: (targets: readonly HarnessBulkUpdateTarget[]) =>
      runHarnessBulkUpdate(targets, (target) =>
        postProjectHarnessInject(target.projectId, target.packName),
      ),
    onMutate: () => {
      setBulkUpdateSummary(null);
      clearRepairFeedback();
    },
    onSuccess: async (summary) => {
      await queryClient.invalidateQueries({ queryKey: ['project-harness'] });
      await queryClient.invalidateQueries({ queryKey: ['harness-drift'] });
      await queryClient.invalidateQueries({ queryKey: ['harness-status-all'] });
      setBulkUpdateTargets(null);
      setBulkUpdateSummary(summary);
      // 件数は常駐の aria-live に流す (後から挿入された role=status は読まれにくい)。
      showRepairStatusMessage(buildHarnessBulkSummaryMessage(summary));
    },
  });

  /**
   * 検証コントラクト不足を直すチケット起票 (bdboard-p5l.25)。drift/hooks の
   * 「再注入で直す」とは違い、bd 側にチケットを立てるだけ (ファイルは書き換えない)。
   * 冪等性 (既存の harness-contract ラベル付き未クローズチケットがあれば新規作成しない)
   * はサーバー側 (fileHarnessContractTicket) の責務 — ここは結果の created で
   * 文言を出し分けるだけ。
   */
  const contractTicketMutation = useMutation({
    mutationFn: async (vars: { rowKey: string; projectId: string }) => {
      const result = await postProjectHarnessContractTicket(vars.projectId);
      return { ...vars, result };
    },
    onMutate: (vars) => {
      setPendingRepairKey(vars.rowKey);
      clearRepairFeedback();
    },
    onSuccess: async (vars) => {
      await queryClient.invalidateQueries({ queryKey: ['harness-drift'] });
      await queryClient.invalidateQueries({
        queryKey: ['project-harness', vars.projectId],
      });
      setConfirmingRepairKey(null);
      setPendingRepairKey(null);
      // 単体で直した後に古い一括結果 (「失敗」行など) を残さない。
      setBulkUpdateSummary(null);
      // bdboard-13mp: state 遷移をまたいだ陳腐化チケットの扱い — 文言に使う contract は
      // クリック時点でこのコンポーネントがポーリングでキャッシュしていた item.contract
      // ではなく、サーバーがこのリクエストで実際に読んだ vars.result.contract を使う
      // (レビュー指摘)。ポーリングキャッシュとの間には、最後のポーリングからクリック
      // までの間に契約ファイルが変わっている可能性がある窓があり、それをそのまま
      // 使うと「追記した」と言いながら別の (古い) 状態名を出しかねない — まさに
      // この機能が直そうとしている陳腐化表示をクライアント側で再発させてしまう。
      showRepairStatusMessage(
        buildHarnessContractTicketSuccessMessage(
          vars.result.ticketId,
          vars.result.created,
          vars.result.stateAppend,
          vars.result.contract,
        ),
      );
    },
    onError: (error, vars) => {
      setPendingRepairKey(null);
      setRepairError({
        rowKey: vars.rowKey,
        message: describeWriteError(error, 'チケットの起票に失敗しました'),
      });
    },
  });

  const handleConfirmRepair = useCallback(
    (issue: HygieneIssueDto, rowKey: string) => {
      if (repairMutation.isPending) {
        return;
      }
      const built = buildRepairRequest(issue);
      if (built === null) {
        return;
      }
      repairMutation.mutate({
        rowKey,
        ticketId: issue.ticketId,
        request: built.request,
        previousDeferUntil: built.previousDeferUntil,
      });
    },
    [repairMutation],
  );

  // drift 行と hook 未登録行はどちらも「再注入で直す」なので同じハンドラを使う。
  const handleConfirmHarnessUpdate = useCallback(
    (item: HarnessPackItem, rowKey: string) => {
      if (repairMutation.isPending || harnessInjectMutation.isPending) {
        return;
      }
      harnessInjectMutation.mutate({
        rowKey,
        projectId: item.projectId,
        pack: item.pack,
      });
    },
    [harnessInjectMutation, repairMutation.isPending],
  );

  const handleConfirmContractTicket = useCallback(
    (item: HarnessContractItem, rowKey: string) => {
      if (contractTicketMutation.isPending) {
        return;
      }
      contractTicketMutation.mutate({ rowKey, projectId: item.projectId });
    },
    [contractTicketMutation],
  );

  const beginBulkUpdateConfirm = useCallback(
    (items: readonly HarnessPackItem[]) => {
      setBulkUpdateSummary(null);
      setConfirmingRepairKey(null);
      clearRepairFeedback();
      setBulkUpdateTargets(
        items.map(({ projectId, pack }) => ({
          projectId,
          packName: pack.name,
          installedVersion: pack.installedVersion,
          availableVersion: pack.availableVersion,
        })),
      );
    },
    [clearRepairFeedback],
  );

  const confirmBulkUpdate = useCallback(() => {
    if (bulkUpdateTargets !== null && !harnessBulkUpdateMutation.isPending) {
      harnessBulkUpdateMutation.mutate(bulkUpdateTargets);
    }
  }, [bulkUpdateTargets, harnessBulkUpdateMutation]);

  // 確認欄を開いたら確定ボタンへフォーカスを移す (トリガーのボタンはアンマウントされる)。
  const bulkConfirmButtonRef = useRef<HTMLButtonElement>(null);
  const isBulkConfirming = bulkUpdateTargets !== null;
  useEffect(() => {
    if (isBulkConfirming) {
      bulkConfirmButtonRef.current?.focus();
    }
  }, [isBulkConfirming]);

  const repairDisabled =
    repairMutation.isPending ||
    harnessInjectMutation.isPending ||
    harnessBulkUpdateMutation.isPending ||
    contractTicketMutation.isPending;

  const cancelRepairConfirm = useCallback(() => {
    setConfirmingRepairKey(null);
  }, []);

  const cancelBulkUpdateTargets = useCallback(() => {
    setBulkUpdateTargets(null);
  }, []);

  const closeBulkUpdateSummary = useCallback(() => {
    setBulkUpdateSummary(null);
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
