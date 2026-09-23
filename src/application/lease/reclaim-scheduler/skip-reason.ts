// bdboard-sso1.51: reclaim-scheduler.ts のモジュール分割。巡回を見送った理由の健全性表示
// (rawSummary) をまとめたモジュール (move only, 挙動変更ゼロ)。
import type { ReclaimSkipReason } from './types.js';

/**
 * 見送り理由ごとの健全性表示 (rawSummary)。以前は理由を問わず「生存証拠を判定
 * できませんでした」一本で、bd 側の失敗でも git の話に見えていた (bdboard-2hsq)。
 */
export function describeReclaimSkip(reason: ReclaimSkipReason): string {
  switch (reason) {
    case 'lease-read-failed':
      return 'skipped: bd の in_progress 一覧を読めませんでした';
    case 'scan-incomplete':
      return 'skipped: git の worktree / bd ブランチ一覧を最後まで読めず、生存証拠を判定できませんでした';
    case 'scan-failed':
      return 'skipped: git worktree を走査できず、生存証拠を判定できませんでした';
    default: {
      // 理由を足したのに表示を足し忘れたら tsc で落とす。
      const unreachable: never = reason;
      return `skipped: ${String(unreachable)}`;
    }
  }
}
