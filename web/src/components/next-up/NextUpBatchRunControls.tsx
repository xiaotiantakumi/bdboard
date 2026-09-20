// bdboard-sso1.43: NextUpView.tsx の「▶ 一括実行」ボタン・確認ダイアログ・
// 進捗表示 (next-up-run-group) を移動しただけの表示専用コンポーネント。
// state・ref は親 (NextUpView / useNextUpBatchRun) に残し、値とハンドラを
// props で受け取る。isLoopActive / hasLastRunSummary は loopPhase /
// loopProgress からこの中で導出する — 移動前は NextUpView.tsx 直下の同じ式で
// 計算されていたものをそのままここへ移した (親側には残していない。重複では
// なく移動)。
// JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
import type { RefObject } from 'react';
import {
  NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES,
  type NextUpLoopPhase,
  type NextUpLoopProgress,
} from '../nextUpRunLoop';
import { renderLoopProgressSummary } from './nextUpHelpers';

export interface NextUpBatchRunControlsProps {
  loopPhase: NextUpLoopPhase;
  loopProgress: NextUpLoopProgress;
  harnessBlockReason: string | null;
  hasVisibleRegularCards: boolean;
  pendingBatchTicketIds: readonly string[] | null;
  batchRunConfirmRef: RefObject<HTMLDivElement | null>;
  cancelBatchRunConfirmRef: RefObject<HTMLButtonElement | null>;
  onOpenConfirm: () => void;
  onStopLoop: () => void;
  onCancelConfirm: () => void;
  onConfirmRun: () => void;
}

export function NextUpBatchRunControls({
  loopPhase,
  loopProgress,
  harnessBlockReason,
  hasVisibleRegularCards,
  pendingBatchTicketIds,
  batchRunConfirmRef,
  cancelBatchRunConfirmRef,
  onOpenConfirm,
  onStopLoop,
  onCancelConfirm,
  onConfirmRun,
}: NextUpBatchRunControlsProps) {
  const isLoopActive = loopPhase !== 'idle';
  const hasLastRunSummary = !isLoopActive && loopProgress.totalCount > 0;

  return (
    <div className="next-up-run-group">
      {!isLoopActive ? (
        <button
          type="button"
          className="toggle-btn next-up-run-btn"
          disabled={!hasVisibleRegularCards || harnessBlockReason !== null}
          title={harnessBlockReason ?? undefined}
          onClick={onOpenConfirm}
        >
          ▶ 一括実行
        </button>
      ) : (
        <button
          type="button"
          className="toggle-btn next-up-run-btn next-up-run-btn-stop"
          disabled={loopPhase === 'stopping'}
          onClick={onStopLoop}
        >
          {loopPhase === 'stopping' ? '■ 停止中…' : '■ 停止'}
        </button>
      )}
      {harnessBlockReason !== null && !isLoopActive && (
        <p className="next-up-run-blocked-reason">{harnessBlockReason}</p>
      )}
      {pendingBatchTicketIds !== null && !isLoopActive && (
        <div
          ref={batchRunConfirmRef}
          className="quick-action-confirm-panel next-up-run-confirm-panel"
          role="alertdialog"
          aria-labelledby="next-up-run-confirm-title"
          aria-describedby="next-up-run-confirm-desc"
        >
          <p
            id="next-up-run-confirm-title"
            className="quick-action-confirm-title"
          >
            一括実行の確認
          </p>
          <p
            id="next-up-run-confirm-desc"
            className="quick-action-confirm-desc"
          >
            表示中の着手可能チケット {pendingBatchTicketIds.length}{' '}
            件を、上から1件ずつ直列でエージェント実行します。Epic
            セクションのチケットは対象に含まれません。各チケットごとに
            worktree の作成（またはクリーンな既存 worktree の再利用）と Claude
            CLI の起動が走ります。1件失敗しても次へ進みますが、直近
            {NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES}
            件が失敗した場合はバッチを停止し、最後に失敗したチケットへ停止理由のコメントを残します。よろしいですか?
          </p>
          <div className="quick-action-confirm-actions">
            <button
              ref={cancelBatchRunConfirmRef}
              type="button"
              className="btn quick-action-confirm-cancel"
              onClick={onCancelConfirm}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="btn"
              onClick={onConfirmRun}
            >
              実行する
            </button>
          </div>
        </div>
      )}
      {(isLoopActive || hasLastRunSummary) && (
        <>
          <p
            className="next-up-run-progress"
            role="status"
            aria-live="polite"
          >
            {isLoopActive ? (
              <>
                {loopProgress.currentTicketId !== null
                  ? `現在: ${loopProgress.currentTicketId} | `
                  : ''}
                {renderLoopProgressSummary(loopProgress)}
              </>
            ) : (
              renderLoopProgressSummary(loopProgress, {
                prefix: '前回の実行:',
                showEndReason: true,
              })
            )}
          </p>
          {loopProgress.lastFailureReason !== null && (
            <p className="next-up-run-failure-reason error-message">
              {loopProgress.lastFailureReason}
            </p>
          )}
          {!isLoopActive && loopProgress.currentTicketId !== null && (
            <p className="next-up-run-server-active-hint">
              {loopProgress.currentTicketId}{' '}
              はサーバー側で実行中の可能性があります
            </p>
          )}
        </>
      )}
    </div>
  );
}
