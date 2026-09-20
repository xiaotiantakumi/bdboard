// bdboard-sso1.5 (PR-K): TicketDetailPanel.tsx の「クイックアクション」表示
// ブロックを移動しただけのコンポーネント。state・mutation・focus trap は
// useTicketQuickActions (親で呼び出し) に残し、値とハンドラを props で受け取る
// 表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前から
// 変えていない。
import type { RefObject } from 'react';
import { describeWriteError } from '../../writeAccessMessage';
import {
  DEFER_PERIOD_OPTIONS,
  todayLocalDateInputValue,
  type DeferPeriodKind,
} from '../../deferPeriods';
import { formatQuickActionConfirmTitle, formatQuickActionConfirmDescription } from './quickActionConfirm';
import type { ConfirmingQuickAction } from './types';

export interface TicketQuickActionsSectionProps {
  priority: number;
  confirmingQuickAction: ConfirmingQuickAction | null;
  onSetConfirmingQuickAction: (action: ConfirmingQuickAction) => void;
  quickActionsDisabled: boolean;
  deferPeriodKind: DeferPeriodKind;
  onDeferPeriodKindChange: (kind: DeferPeriodKind) => void;
  customDeferDate: string;
  onCustomDeferDateChange: (value: string) => void;
  deferSubmitDisabled: boolean;
  onDeferQuickAction: () => void;
  canRaisePriority: boolean;
  canLowerPriority: boolean;
  quickActionConfirmRef: RefObject<HTMLDivElement | null>;
  cancelQuickActionRef: RefObject<HTMLButtonElement | null>;
  onCancelQuickAction: () => void;
  closeReason: string;
  onCloseReasonChange: (value: string) => void;
  mutationPending: boolean;
  onConfirmQuickAction: () => void;
  mutationError: unknown;
}

export function TicketQuickActionsSection({
  priority,
  confirmingQuickAction,
  onSetConfirmingQuickAction,
  quickActionsDisabled,
  deferPeriodKind,
  onDeferPeriodKindChange,
  customDeferDate,
  onCustomDeferDateChange,
  deferSubmitDisabled,
  onDeferQuickAction,
  canRaisePriority,
  canLowerPriority,
  quickActionConfirmRef,
  cancelQuickActionRef,
  onCancelQuickAction,
  closeReason,
  onCloseReasonChange,
  mutationPending,
  onConfirmQuickAction,
  mutationError,
}: TicketQuickActionsSectionProps) {
  return (
    <div className="detail-section">
      <h3>クイックアクション</h3>
      <p className="detail-help">
        ローカル画面から bd コマンドを直接実行します(確認あり)
      </p>
      <div className="quick-action-buttons">
        <button
          type="button"
          className="btn quick-action-btn"
          disabled={quickActionsDisabled}
          onClick={() => onSetConfirmingQuickAction({ kind: 'claim' })}
        >
          着手
        </button>
        <button
          type="button"
          className="btn quick-action-btn"
          disabled={quickActionsDisabled}
          onClick={() => onSetConfirmingQuickAction({ kind: 'close' })}
        >
          完了
        </button>
        <div className="quick-action-defer-group">
          <select
            aria-label="延期期間"
            value={deferPeriodKind}
            onChange={(event) =>
              onDeferPeriodKindChange(event.target.value as DeferPeriodKind)
            }
            disabled={quickActionsDisabled}
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
              onChange={(event) => onCustomDeferDateChange(event.target.value)}
              disabled={quickActionsDisabled}
            />
          )}
          <button
            type="button"
            className="btn quick-action-btn"
            disabled={quickActionsDisabled || deferSubmitDisabled}
            onClick={onDeferQuickAction}
          >
            延期
          </button>
        </div>
        <button
          type="button"
          className="btn quick-action-btn"
          disabled={quickActionsDisabled || !canRaisePriority}
          onClick={() =>
            onSetConfirmingQuickAction({
              kind: 'priority',
              priority: Math.max(0, priority - 1),
            })
          }
        >
          優先度を上げる
        </button>
        <button
          type="button"
          className="btn quick-action-btn"
          disabled={quickActionsDisabled || !canLowerPriority}
          onClick={() =>
            onSetConfirmingQuickAction({
              kind: 'priority',
              priority: Math.min(4, priority + 1),
            })
          }
        >
          優先度を下げる
        </button>
      </div>
      {confirmingQuickAction !== null && (
        <div
          ref={quickActionConfirmRef}
          className="quick-action-confirm-panel"
          role="alertdialog"
          aria-labelledby="quick-action-confirm-title"
          aria-describedby="quick-action-confirm-desc"
        >
          <p id="quick-action-confirm-title" className="quick-action-confirm-title">
            {formatQuickActionConfirmTitle(confirmingQuickAction)}
          </p>
          <p id="quick-action-confirm-desc" className="quick-action-confirm-desc">
            {formatQuickActionConfirmDescription(confirmingQuickAction)}
          </p>
          {confirmingQuickAction.kind === 'close' && (
            <>
              <label
                className="quick-action-reason-label"
                htmlFor="quick-action-close-reason"
              >
                理由(任意)
              </label>
              <textarea
                id="quick-action-close-reason"
                className="quick-action-reason-input"
                value={closeReason}
                onChange={(event) => onCloseReasonChange(event.target.value)}
                rows={3}
                maxLength={2000}
                disabled={mutationPending}
              />
            </>
          )}
          <div className="quick-action-confirm-actions">
            <button
              ref={cancelQuickActionRef}
              type="button"
              className="btn quick-action-confirm-cancel"
              onClick={onCancelQuickAction}
              disabled={mutationPending}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="btn"
              onClick={onConfirmQuickAction}
              disabled={mutationPending}
            >
              {mutationPending ? '実行中…' : '実行する'}
            </button>
          </div>
        </div>
      )}
      {mutationError !== null && (
        <p className="error-message">
          {describeWriteError(mutationError, 'クイックアクションの実行に失敗しました')}
        </p>
      )}
    </div>
  );
}
