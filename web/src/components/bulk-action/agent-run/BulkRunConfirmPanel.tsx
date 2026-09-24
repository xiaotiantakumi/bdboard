// bdboard-mkm1.2: 一括操作バーの「▶ 実行」の確認ダイアログ (表示専用)。
// 実行件数・実行順・対象外の件数と理由を出し、「実行する」で App の実行ループへ渡す。
import type { RefObject } from 'react';
import { NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES } from '../../nextUpRunLoop';
import { type BulkRunPlan, describeBulkRunExclusions } from './bulkRunPlan';

export interface BulkRunConfirmPanelProps {
  plan: BulkRunPlan;
  harnessBlockReason: string | null;
  canConfirm: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirmPanelRef: RefObject<HTMLDivElement | null>;
  cancelConfirmRef: RefObject<HTMLButtonElement | null>;
}

export function BulkRunConfirmPanel({
  plan,
  harnessBlockReason,
  canConfirm,
  onCancel,
  onConfirm,
  confirmPanelRef,
  cancelConfirmRef,
}: BulkRunConfirmPanelProps) {
  const runCount = plan.runTicketIds.length;
  const exclusionText = describeBulkRunExclusions(plan.exclusions);

  return (
    <div
      ref={confirmPanelRef}
      className="quick-action-confirm-panel bulk-action-confirm-panel bulk-run-confirm-panel"
      role="alertdialog"
      aria-labelledby="bulk-run-confirm-title"
      aria-describedby="bulk-run-confirm-desc"
    >
      <p id="bulk-run-confirm-title" className="quick-action-confirm-title">
        エージェント実行の確認
      </p>
      <p id="bulk-run-confirm-desc" className="quick-action-confirm-desc">
        {runCount > 0
          ? `選択中の ${runCount} 件を、優先度の高い順 (レーンの表示順) に1件ずつ直列でエージェント実行します。` +
            '各チケットごとに worktree の作成（またはクリーンな既存 worktree の再利用）と Claude CLI の起動が走ります。' +
            `1件失敗しても次へ進みますが、直近${NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES}件が失敗した場合はバッチを停止し、最後に失敗したチケットへ停止理由のコメントを残します。` +
            '進捗と停止はヘッダーのチップに出ます。実行を始めると選択は解除されます。'
          : '実行できるカードがありません。対象は着手可能レーンにある epic 以外のカードです。'}
      </p>
      {exclusionText !== null && (
        <p className="bulk-run-confirm-excluded">
          対象外 {plan.excludedCount} 件: {exclusionText}
        </p>
      )}
      {harnessBlockReason !== null && (
        <p className="bulk-run-blocked-reason">{harnessBlockReason}</p>
      )}
      {runCount > 0 && (
        <ol className="bulk-run-confirm-list" aria-label="実行順">
          {plan.runCards.map((card) => (
            <li key={card.ticket.id}>
              <span className="bulk-run-confirm-id">{card.ticket.id}</span>{' '}
              {card.ticket.title}
            </li>
          ))}
        </ol>
      )}
      <div className="quick-action-confirm-actions">
        <button
          ref={cancelConfirmRef}
          type="button"
          className="btn quick-action-confirm-cancel"
          onClick={onCancel}
        >
          キャンセル
        </button>
        <button type="button" className="btn" onClick={onConfirm} disabled={!canConfirm}>
          実行する
        </button>
      </div>
    </div>
  );
}
