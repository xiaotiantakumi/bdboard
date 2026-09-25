// bdboard-mkm1.2: エージェントの一括実行の進捗と「■ 停止」をヘッダーに出すチップ。
// 実行ループのコントローラは App (useAppController) が持っていてビューを切り替えても
// 動き続けるので、進捗もビューに依存しない場所 (ヘッダー) に置く。一括操作バーの
// 「▶ 実行」から始めた実行はここに出る (bdboard-mkm1.3: Next Up 自体の「▶ 一括実行」と
// その専用進捗表示は削除、この共通チップだけが残った)。
import { useState } from 'react';
import { renderLoopProgressSummary } from '../next-up/nextUpHelpers';
import type { NextUpLoopProgress, NextUpRunLoopController } from '../nextUpRunLoop';

export interface BatchRunProgressChipProps {
  batchRun: NextUpRunLoopController;
}

export function BatchRunProgressChip({ batchRun }: BatchRunProgressChipProps) {
  const { phase, progress, stopBatchRun } = batchRun;
  // 終了後の結果は「×」で閉じられる。閉じたときの progress (参照) を覚えておき、
  // 次の実行が始まって progress が差し替わったら再び出す。
  const [dismissedProgress, setDismissedProgress] = useState<NextUpLoopProgress | null>(
    null,
  );
  const isActive = phase !== 'idle';
  const showSummary = !isActive && progress.totalCount > 0 && dismissedProgress !== progress;

  if (!isActive && !showSummary) {
    return null;
  }

  const summary = isActive
    ? `${progress.currentTicketId !== null ? `現在: ${progress.currentTicketId} | ` : ''}${renderLoopProgressSummary(progress)}`
    : renderLoopProgressSummary(progress, { prefix: '前回の実行:', showEndReason: true });

  return (
    <div className="batch-run-chip" role="group" aria-label="エージェントの一括実行">
      <div className="batch-run-chip-main">
        <span className="batch-run-chip-label">{isActive ? '▶ 一括実行中' : '一括実行'}</span>
        <span className="batch-run-chip-summary" role="status" aria-live="polite">
          {summary}
        </span>
        {isActive ? (
          <button
            type="button"
            className="btn btn-small batch-run-chip-stop"
            disabled={phase === 'stopping'}
            title="次のチケットへは進まず、進捗の追跡もやめます。実行中の1件はサーバー側で続きます"
            onClick={stopBatchRun}
          >
            {phase === 'stopping' ? '■ 停止中…' : '■ 停止'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-small batch-run-chip-dismiss"
            aria-label="一括実行の結果を閉じる"
            onClick={() => setDismissedProgress(progress)}
          >
            ×
          </button>
        )}
      </div>
      {progress.lastFailureReason !== null && (
        <p className="batch-run-chip-detail error-message">{progress.lastFailureReason}</p>
      )}
      {!isActive && progress.currentTicketId !== null && (
        <p className="batch-run-chip-detail">
          {progress.currentTicketId} はサーバー側で実行中の可能性があります
        </p>
      )}
    </div>
  );
}
