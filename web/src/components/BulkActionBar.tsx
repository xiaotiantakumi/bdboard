import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  postTicketAddLabel,
  postTicketQuickAction,
  postTicketQuickActionUndo,
  type BoardCardDto,
  type QuickActionRequest,
} from '../api';
import {
  computeDeferUntilDate,
  DEFAULT_DEFER_PERIOD,
  DEFER_PERIOD_OPTIONS,
  isFutureLocalDate,
  todayLocalDateInputValue,
  type DeferPeriodKind,
} from '../deferPeriods';
import {
  type BulkIdOutcome,
  type BulkQuickActionOutcome,
  type BulkQuickActionTarget,
  runBulkById,
  runBulkQuickAction,
} from '../bulkQuickAction';
import { planQuickActionUndo } from '../quickActionUndo';
import { isImeComposingKeyEvent } from '../imeGuard';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { describeWriteError } from '../writeAccessMessage';
import { useBulkSelection } from './BulkSelectionProvider';
import { useUndoSnackbar } from './UndoSnackbar';

type BulkConfirmingAction =
  | { kind: 'close' }
  | { kind: 'defer'; untilDate: string }
  | { kind: 'priority-up' }
  | { kind: 'priority-down' }
  | { kind: 'add-label'; label: string };

function formatBulkConfirmTitle(action: BulkConfirmingAction): string {
  switch (action.kind) {
    case 'close':
      return '一括完了の確認';
    case 'defer':
      return '一括延期の確認';
    case 'priority-up':
      return '一括で優先度を上げる確認';
    case 'priority-down':
      return '一括で優先度を下げる確認';
    case 'add-label':
      return '一括ラベル付与の確認';
  }
}

function formatBulkConfirmDescription(
  action: BulkConfirmingAction,
  targetCount: number,
): string {
  switch (action.kind) {
    case 'close':
      return `選択中の ${targetCount} 件を完了にします。よろしいですか?`;
    case 'defer':
      return `選択中の ${targetCount} 件を ${action.untilDate} まで延期します。よろしいですか?`;
    case 'priority-up':
      return `選択中のうち優先度を上げられる ${targetCount} 件の優先度を上げます。よろしいですか?`;
    case 'priority-down':
      return `選択中のうち優先度を下げられる ${targetCount} 件の優先度を下げます。よろしいですか?`;
    case 'add-label':
      return `選択中の ${targetCount} 件にラベル「${action.label}」を付与します。よろしいですか?`;
  }
}

function bulkSuccessMessage(action: BulkConfirmingAction, count: number): string {
  switch (action.kind) {
    case 'close':
      return `${count}件を完了にしました`;
    case 'defer':
      return `${count}件を延期しました`;
    case 'priority-up':
      return `${count}件の優先度を上げました`;
    case 'priority-down':
      return `${count}件の優先度を下げました`;
    case 'add-label':
      return `${count}件にラベルを付与しました`;
  }
}

function filterIdsPresentOnBoard(
  selectedIds: ReadonlySet<string>,
  cardsById: ReadonlyMap<string, BoardCardDto>,
): string[] {
  const ids: string[] = [];
  for (const id of selectedIds) {
    if (cardsById.has(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function buildTargetsForAction(
  action: BulkConfirmingAction,
  selectedIds: ReadonlySet<string>,
  cardsById: ReadonlyMap<string, BoardCardDto>,
  closeReason: string,
): BulkQuickActionTarget[] {
  const targets: BulkQuickActionTarget[] = [];
  for (const id of selectedIds) {
    const card = cardsById.get(id);
    if (card === undefined) {
      continue;
    }
    const priority = card.ticket.priority;
    switch (action.kind) {
      case 'close': {
        const trimmedReason = closeReason.trim();
        const request: QuickActionRequest = {
          action: 'close',
          ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
        };
        targets.push({ id, request });
        break;
      }
      case 'defer':
        targets.push({
          id,
          request: { action: 'defer', untilDate: action.untilDate },
        });
        break;
      case 'priority-up':
        if (priority <= 0) {
          continue;
        }
        targets.push({
          id,
          request: { action: 'priority', priority: priority - 1 },
          previousPriority: priority,
        });
        break;
      case 'priority-down':
        if (priority >= 4) {
          continue;
        }
        targets.push({
          id,
          request: { action: 'priority', priority: priority + 1 },
          previousPriority: priority,
        });
        break;
      case 'add-label':
        break;
    }
  }
  return targets;
}

function countEligibleForAction(
  action: BulkConfirmingAction,
  selectedIds: ReadonlySet<string>,
  cardsById: ReadonlyMap<string, BoardCardDto>,
): number {
  if (action.kind === 'add-label') {
    return filterIdsPresentOnBoard(selectedIds, cardsById).length;
  }
  return buildTargetsForAction(action, selectedIds, cardsById, '').length;
}

function formatBulkFailure(
  outcome: BulkQuickActionOutcome | BulkIdOutcome,
): string {
  const ids = outcome.failed.map((entry) => entry.id).join(', ');
  return `${outcome.failed.length}件失敗: ${ids}`;
}

export interface BulkActionBarProps {
  cardsById: ReadonlyMap<string, BoardCardDto>;
  availableLabels?: readonly string[];
}

export function BulkActionBar({
  cardsById,
  availableLabels = [],
}: BulkActionBarProps) {
  const bulkSelection = useBulkSelection();
  const undoSnackbar = useUndoSnackbar();
  const queryClient = useQueryClient();
  const [confirmingAction, setConfirmingAction] =
    useState<BulkConfirmingAction | null>(null);
  const [deferPeriodKind, setDeferPeriodKind] =
    useState<DeferPeriodKind>(DEFAULT_DEFER_PERIOD);
  const [customDeferDate, setCustomDeferDate] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const [bulkLabelInput, setBulkLabelInput] = useState('');
  const [lastOutcome, setLastOutcome] = useState<
    BulkQuickActionOutcome | BulkIdOutcome | null
  >(null);
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);

  const selectedIds = bulkSelection?.selectedIds ?? new Set<string>();
  const selectedCount = selectedIds.size;

  const trimmedBulkLabelInput = bulkLabelInput.trim();
  const bulkLabelSuggestions = availableLabels
    .filter(
      (label) =>
        trimmedBulkLabelInput.length === 0 ||
        label.toLowerCase().includes(trimmedBulkLabelInput.toLowerCase()),
    )
    .slice(0, 20);

  const canSubmitBulkLabel = trimmedBulkLabelInput.length > 0;

  const canRaiseAny = useMemo(() => {
    for (const id of selectedIds) {
      const card = cardsById.get(id);
      if (card !== undefined && card.ticket.priority > 0) {
        return true;
      }
    }
    return false;
  }, [selectedIds, cardsById]);

  const canLowerAny = useMemo(() => {
    for (const id of selectedIds) {
      const card = cardsById.get(id);
      if (card !== undefined && card.ticket.priority < 4) {
        return true;
      }
    }
    return false;
  }, [selectedIds, cardsById]);

  const bulkMutation = useMutation({
    mutationFn: async (vars: {
      action: BulkConfirmingAction;
      targets: BulkQuickActionTarget[];
    }) => {
      const outcome = await runBulkQuickAction(
        vars.targets,
        postTicketQuickAction,
      );
      return { action: vars.action, outcome };
    },
    onSuccess: async ({ action, outcome }) => {
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setLastOutcome(outcome);
      setConfirmingAction(null);
      setDeferPeriodKind(DEFAULT_DEFER_PERIOD);
      setCustomDeferDate('');
      setCloseReason('');
      bulkSelection?.deselectAll(outcome.succeeded.map((target) => target.id));

      if (outcome.succeeded.length > 0 && undoSnackbar !== null) {
        const succeeded = outcome.succeeded;
        undoSnackbar.showUndo({
          message: bulkSuccessMessage(action, succeeded.length),
          onUndo: async () => {
            const undoFailedIds: string[] = [];
            let undoSucceededCount = 0;
            for (const target of succeeded) {
              const plan = planQuickActionUndo(
                target.request,
                target.previousPriority,
              );
              if (plan === null) {
                continue;
              }
              try {
                await postTicketQuickActionUndo(target.id, plan.undoRequest);
                undoSucceededCount += 1;
              } catch {
                undoFailedIds.push(target.id);
              }
            }
            await queryClient.invalidateQueries({ queryKey: ['board'] });
            if (undoFailedIds.length > 0) {
              throw new Error(
                `${undoSucceededCount}件中${undoFailedIds.length}件は元に戻せませんでした（対象: ${undoFailedIds.join(', ')}）`,
              );
            }
          },
        });
      }
    },
  });

  const bulkLabelMutation = useMutation({
    mutationFn: async (vars: { label: string; ids: string[] }) => {
      const outcome = await runBulkById(vars.ids, (id) =>
        postTicketAddLabel(id, vars.label),
      );
      return { label: vars.label, outcome };
    },
    onSuccess: async ({ outcome }) => {
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setLastOutcome(outcome);
      setConfirmingAction(null);
      setBulkLabelInput('');
      bulkSelection?.deselectAll(outcome.succeeded);
    },
  });

  const handleCancelConfirm = useCallback(() => {
    if (bulkMutation.isPending || bulkLabelMutation.isPending) {
      return;
    }
    setConfirmingAction(null);
    setDeferPeriodKind(DEFAULT_DEFER_PERIOD);
    setCustomDeferDate('');
    setCloseReason('');
  }, [bulkMutation.isPending, bulkLabelMutation.isPending]);

  useFocusTrap({
    containerRef: confirmPanelRef,
    initialFocusRef: cancelConfirmRef,
    enabled: confirmingAction !== null,
    onEscape: handleCancelConfirm,
  });

  const handleConfirm = useCallback(() => {
    if (confirmingAction === null) {
      return;
    }
    if (confirmingAction.kind === 'add-label') {
      const ids = filterIdsPresentOnBoard(selectedIds, cardsById);
      if (ids.length === 0) {
        return;
      }
      bulkLabelMutation.mutate({ label: confirmingAction.label, ids });
      return;
    }
    const targets = buildTargetsForAction(
      confirmingAction,
      selectedIds,
      cardsById,
      closeReason,
    );
    if (targets.length === 0) {
      return;
    }
    bulkMutation.mutate({ action: confirmingAction, targets });
  }, [
    confirmingAction,
    selectedIds,
    cardsById,
    closeReason,
    bulkMutation,
    bulkLabelMutation,
  ]);

  const handleDeferBulkAction = useCallback(() => {
    const untilDate =
      deferPeriodKind === 'custom'
        ? customDeferDate
        : computeDeferUntilDate(deferPeriodKind);
    setConfirmingAction({ kind: 'defer', untilDate });
  }, [customDeferDate, deferPeriodKind]);

  const handleBulkLabelAction = useCallback(() => {
    if (!canSubmitBulkLabel) {
      return;
    }
    setConfirmingAction({ kind: 'add-label', label: trimmedBulkLabelInput });
  }, [canSubmitBulkLabel, trimmedBulkLabelInput]);

  if (bulkSelection === null || selectedCount === 0) {
    return null;
  }

  const confirmingTargetCount =
    confirmingAction !== null
      ? countEligibleForAction(confirmingAction, selectedIds, cardsById)
      : 0;

  const actionsDisabled =
    bulkMutation.isPending ||
    bulkLabelMutation.isPending ||
    confirmingAction !== null;
  const deferSubmitDisabled =
    deferPeriodKind === 'custom' && !isFutureLocalDate(customDeferDate);
  const mutationPending = bulkMutation.isPending || bulkLabelMutation.isPending;
  const mutationError = bulkMutation.error ?? bulkLabelMutation.error;

  return (
    <div className="bulk-action-bar">
      <div className="bulk-action-bar-summary">
        <span className="bulk-action-bar-count">{selectedCount}件選択中</span>
        <button
          type="button"
          className="btn btn-small bulk-action-bar-clear"
          onClick={() => bulkSelection.clear()}
          disabled={mutationPending}
        >
          全解除
        </button>
      </div>
      <div className="bulk-action-bar-buttons">
        <button
          type="button"
          className="btn btn-small bulk-action-btn"
          disabled={actionsDisabled}
          onClick={() => setConfirmingAction({ kind: 'close' })}
        >
          完了
        </button>
        <div className="quick-action-defer-group">
          <select
            aria-label="延期期間"
            value={deferPeriodKind}
            onChange={(event) =>
              setDeferPeriodKind(event.target.value as DeferPeriodKind)
            }
            disabled={actionsDisabled}
          >
            {DEFER_PERIOD_OPTIONS.map(({ kind, label }) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
          {deferPeriodKind === 'custom' && (
            <input
              type="date"
              min={todayLocalDateInputValue()}
              value={customDeferDate}
              onChange={(event) => setCustomDeferDate(event.target.value)}
              disabled={actionsDisabled}
            />
          )}
          <button
            type="button"
            className="btn btn-small bulk-action-btn"
            disabled={actionsDisabled || deferSubmitDisabled}
            onClick={handleDeferBulkAction}
          >
            延期
          </button>
        </div>
        <button
          type="button"
          className="btn btn-small bulk-action-btn"
          disabled={actionsDisabled || !canRaiseAny}
          onClick={() => setConfirmingAction({ kind: 'priority-up' })}
        >
          優先度を上げる
        </button>
        <button
          type="button"
          className="btn btn-small bulk-action-btn"
          disabled={actionsDisabled || !canLowerAny}
          onClick={() => setConfirmingAction({ kind: 'priority-down' })}
        >
          優先度を下げる
        </button>
        <div className="bulk-action-label-group">
          <input
            type="text"
            className="bulk-action-label-input"
            aria-label="付与するラベル"
            value={bulkLabelInput}
            onChange={(event) => setBulkLabelInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                if (isImeComposingKeyEvent(event)) {
                  return;
                }
                event.preventDefault();
                if (canSubmitBulkLabel && !actionsDisabled) {
                  handleBulkLabelAction();
                }
              }
            }}
            disabled={actionsDisabled}
            maxLength={200}
            placeholder="ラベル"
          />
          {trimmedBulkLabelInput.length > 0 &&
            bulkLabelSuggestions.length > 0 && (
              <ul className="dependency-suggestions bulk-label-suggestions">
                {bulkLabelSuggestions.map((label) => (
                  <li key={label}>
                    <button
                      type="button"
                      className="dependency-suggestion-btn"
                      disabled={actionsDisabled}
                      onClick={() => {
                        setBulkLabelInput(label);
                        setConfirmingAction({ kind: 'add-label', label });
                      }}
                    >
                      {label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          <button
            type="button"
            className="btn btn-small bulk-action-btn"
            disabled={actionsDisabled || !canSubmitBulkLabel}
            onClick={handleBulkLabelAction}
          >
            ラベル付与
          </button>
        </div>
      </div>
      {lastOutcome !== null && lastOutcome.failed.length > 0 && (
        <p className="bulk-action-failure" role="alert">
          {formatBulkFailure(lastOutcome)}
        </p>
      )}
      {mutationError !== null && (
        <p className="error-message bulk-action-error">
          {describeWriteError(
            mutationError,
            '一括操作に失敗しました',
          )}
        </p>
      )}
      {confirmingAction !== null && (
        <div
          ref={confirmPanelRef}
          className="quick-action-confirm-panel bulk-action-confirm-panel"
          role="alertdialog"
          aria-labelledby="bulk-action-confirm-title"
          aria-describedby="bulk-action-confirm-desc"
        >
          <p
            id="bulk-action-confirm-title"
            className="quick-action-confirm-title"
          >
            {formatBulkConfirmTitle(confirmingAction)}
          </p>
          <p
            id="bulk-action-confirm-desc"
            className="quick-action-confirm-desc"
          >
            {formatBulkConfirmDescription(
              confirmingAction,
              confirmingTargetCount,
            )}
          </p>
          {confirmingAction.kind === 'close' && (
            <>
              <label
                className="quick-action-reason-label"
                htmlFor="bulk-action-close-reason"
              >
                理由(任意)
              </label>
              <textarea
                id="bulk-action-close-reason"
                className="quick-action-reason-input"
                value={closeReason}
                onChange={(event) => setCloseReason(event.target.value)}
                rows={3}
                maxLength={2000}
                disabled={mutationPending}
              />
            </>
          )}
          <div className="quick-action-confirm-actions">
            <button
              ref={cancelConfirmRef}
              type="button"
              className="btn quick-action-confirm-cancel"
              onClick={handleCancelConfirm}
              disabled={mutationPending}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleConfirm}
              disabled={
                mutationPending || confirmingTargetCount === 0
              }
            >
              {mutationPending ? '実行中…' : '実行する'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}