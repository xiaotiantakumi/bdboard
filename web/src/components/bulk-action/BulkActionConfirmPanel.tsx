// bdboard-sso1.23 PR-B: BulkActionBar.tsx から確認ダイアログ(タイトル/説明/理由入力/実行・キャンセル)の表示部品を
// move-only で切り出しただけのファイル。state は親(BulkActionBar)に残し、
// props 経由で渡す。DOM(JSX)は移動前と同一。
import type { RefObject } from 'react';
import { formatBulkConfirmDescription, formatBulkConfirmTitle } from './messages';
import type { BulkConfirmingAction } from './types';

export interface BulkActionConfirmPanelProps {
  confirmingAction: BulkConfirmingAction;
  confirmingTargetCount: number;
  closeReason: string;
  onCloseReasonChange: (value: string) => void;
  mutationPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirmPanelRef: RefObject<HTMLDivElement | null>;
  cancelConfirmRef: RefObject<HTMLButtonElement | null>;
}

export function BulkActionConfirmPanel({
  confirmingAction,
  confirmingTargetCount,
  closeReason,
  onCloseReasonChange,
  mutationPending,
  onCancel,
  onConfirm,
  confirmPanelRef,
  cancelConfirmRef,
}: BulkActionConfirmPanelProps) {
  return (
    <div
      ref={confirmPanelRef}
      className="quick-action-confirm-panel bulk-action-confirm-panel"
      role="alertdialog"
      aria-labelledby="bulk-action-confirm-title"
      aria-describedby="bulk-action-confirm-desc"
    >
      <p id="bulk-action-confirm-title" className="quick-action-confirm-title">
        {formatBulkConfirmTitle(confirmingAction)}
      </p>
      <p id="bulk-action-confirm-desc" className="quick-action-confirm-desc">
        {formatBulkConfirmDescription(confirmingAction, confirmingTargetCount)}
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
            onChange={(event) => onCloseReasonChange(event.target.value)}
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
          onClick={onCancel}
          disabled={mutationPending}
        >
          キャンセル
        </button>
        <button
          type="button"
          className="btn"
          onClick={onConfirm}
          disabled={mutationPending || confirmingTargetCount === 0}
        >
          {mutationPending ? '実行中…' : '実行する'}
        </button>
      </div>
    </div>
  );
}
