// bdboard-sso1.5 (PR-L): TicketDetailPanel.tsx の「エージェント実行」開始ボタン
// (ticket-action-buttons 内の一部) と確認ダイアログ/開始エラーを移動しただけの
// 表示専用コンポーネント。state・mutation は useTicketAgentRun (親で呼び出し)
// に残し、値とハンドラを props で受け取る。JSX・className・aria属性・文言・
// DOM構造は移動前から変えていない。
//
// 元の JSX では実行ボタン等が ticket-action-buttons div の**内側**、確認ダイアログ
// と開始エラーがその**外側**(兄弟要素)にあったため、そのまま1コンポーネントに
// すると DOM 構造が変わってしまう。ボタン側 (TicketAgentRunTrigger) と
// ダイアログ側 (TicketAgentRunConfirm) の2コンポーネントに分けて呼び出し元
// (親の JSX) 側で元通りの位置に置くことで構造を保っている。
import type { RefObject } from 'react';
import { describeRunStartError } from '../agentRunShared';

export interface TicketAgentRunTriggerProps {
  agentRunActionsDisabled: boolean;
  runStartDisabled: { disabled: boolean; reason?: string };
  harnessRunBlockReason: string | null;
  hasActiveRun: boolean;
  onStartConfirm: () => void;
}

export function TicketAgentRunTrigger({
  agentRunActionsDisabled,
  runStartDisabled,
  harnessRunBlockReason,
  hasActiveRun,
  onStartConfirm,
}: TicketAgentRunTriggerProps) {
  return (
    <>
      <button
        type="button"
        className="btn ticket-run-btn"
        disabled={
          agentRunActionsDisabled ||
          runStartDisabled.disabled ||
          harnessRunBlockReason !== null
        }
        title={runStartDisabled.reason ?? harnessRunBlockReason ?? undefined}
        onClick={onStartConfirm}
      >
        ▶ 実行
      </button>
      {harnessRunBlockReason !== null && (
        <span className="agent-run-blocked-reason">
          {harnessRunBlockReason}
        </span>
      )}
      {hasActiveRun && (
        <span className="agent-run-active-indicator">実行中</span>
      )}
    </>
  );
}

export interface TicketAgentRunConfirmProps {
  ticketId: string;
  confirmingAgentRun: boolean;
  agentRunConfirmRef: RefObject<HTMLDivElement | null>;
  cancelAgentRunConfirmRef: RefObject<HTMLButtonElement | null>;
  onCancelAgentRun: () => void;
  onStartRun: () => void;
  startRunPending: boolean;
  startRunError: unknown;
}

export function TicketAgentRunConfirm({
  ticketId,
  confirmingAgentRun,
  agentRunConfirmRef,
  cancelAgentRunConfirmRef,
  onCancelAgentRun,
  onStartRun,
  startRunPending,
  startRunError,
}: TicketAgentRunConfirmProps) {
  return (
    <>
      {confirmingAgentRun && (
        <div
          ref={agentRunConfirmRef}
          className="quick-action-confirm-panel agent-run-confirm-panel"
          role="alertdialog"
          aria-labelledby="agent-run-confirm-title"
          aria-describedby="agent-run-confirm-desc"
        >
          <p
            id="agent-run-confirm-title"
            className="quick-action-confirm-title"
          >
            エージェント実行の確認
          </p>
          <p
            id="agent-run-confirm-desc"
            className="quick-action-confirm-desc"
          >
            対象チケット用の worktree（.claude/worktrees/{ticketId}
            ）を新規作成するか、既に存在してクリーンならそれを再利用して、Claude
            CLI を起動します。対象 worktree
            に未コミットの変更がある場合は実行できません。よろしいですか?
          </p>
          <div className="quick-action-confirm-actions">
            <button
              ref={cancelAgentRunConfirmRef}
              type="button"
              className="btn quick-action-confirm-cancel"
              onClick={onCancelAgentRun}
              disabled={startRunPending}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="btn"
              onClick={onStartRun}
              disabled={startRunPending}
            >
              {startRunPending ? '実行中…' : '実行する'}
            </button>
          </div>
        </div>
      )}
      {startRunError !== null && (
        <p className="error-message">
          {describeRunStartError(startRunError)}
        </p>
      )}
    </>
  );
}
