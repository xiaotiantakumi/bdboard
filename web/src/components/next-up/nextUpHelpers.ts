// bdboard-sso1.43: NextUpView.tsx の純ヘルパー (React 非依存) を移動しただけ。
// 挙動・出力文字列は移動前から変えていない。
import type { BoardDto } from '../../api';
import type { NextUpLoopEndReason, NextUpLoopProgress } from '../nextUpRunLoop';

export function splitReadyCards(readyCards: BoardDto['lanes']['ready']) {
  const regularCards = [];
  const epicCards = [];
  for (const card of readyCards) {
    if (card.ticket.issueType === 'epic') {
      epicCards.push(card);
    } else {
      regularCards.push(card);
    }
  }
  return { regularCards, epicCards };
}

/** endReason ごとの表示ラベル。Record なので endReason が増えたら型エラーで気づける。 */
const NEXT_UP_LOOP_END_REASON_LABELS: Record<NextUpLoopEndReason, string> = {
  completed: '完走',
  stopped: '中断',
  poll_failed: '中断(状況を確認できず)',
  consecutive_failures: '中断(連続失敗)',
};

export function renderLoopProgressSummary(
  progress: NextUpLoopProgress,
  options?: { prefix?: string; showEndReason?: boolean },
): string {
  const completedPart = `完了 ${progress.completedCount}/${progress.totalCount}`;
  const parts: string[] = [];

  if (options?.prefix !== undefined && options.prefix.length > 0) {
    let header = options.prefix;
    if (options.showEndReason && progress.endReason !== null) {
      header = `${header} ${NEXT_UP_LOOP_END_REASON_LABELS[progress.endReason]}`;
    }
    parts.push(`${header} | ${completedPart}`);
  } else {
    parts.push(completedPart);
  }

  parts.push(`失敗 ${progress.failedCount}`);
  if (progress.cancelledCount > 0) {
    parts.push(`中止 ${progress.cancelledCount}`);
  }
  if (progress.unknownCount > 0) {
    parts.push(`不明 ${progress.unknownCount}`);
  }
  if (options?.showEndReason) {
    let runningCount = 0;
    if (progress.endReason === 'stopped' && progress.currentTicketId !== null) {
      runningCount = 1;
      parts.push(`実行中 ${runningCount}`);
    }
    const remaining =
      progress.totalCount -
      (progress.completedCount +
        progress.failedCount +
        progress.cancelledCount +
        progress.unknownCount +
        runningCount);
    if (remaining > 0) {
      parts.push(`未実行 ${remaining}`);
    }
  }
  return parts.join(' | ');
}
