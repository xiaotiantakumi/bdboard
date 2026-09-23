/** 連続失敗の上限。これに達した時点でバッチを止める（verification.md の
 * 「2回連続で失敗したら記録して手を止める」と揃える）。
 * cancelled はカウンタを増減しないので、厳密には「直近 N 件が失敗」である。
 *
 * この値は利用者向けの文言にも出る。定数を埋め込めない箇所は以下だけなので、
 * 値を変えたらここも直すこと:
 * - docs/help-content.json の `agent-runs` セクション（「直近2件が失敗した場合は…」）
 * - web/src/components/nextUpRunLoop.test.ts の文言アサーション（意図的な固定値） */
export const NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES = 2;

/** 停止コメント投稿の待ち上限。これを超えたら投稿を諦めてループを畳む。
 * 上限が無いと、ハングした POST が runNextUpTicketLoop を resolve させず、
 * useNextUpRunLoopController の finally に到達しないため loopActiveRef が
 * true のまま張り付き、一括実行ボタンがリロードするまで復帰しない。 */
export const NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS = 10_000;

export function describeConsecutiveFailureStop(
  lastFailureReason: string | null,
): string {
  const suffix =
    lastFailureReason !== null && lastFailureReason.length > 0
      ? `（最後の失敗: ${lastFailureReason}）`
      : '';
  return `直近${NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES}件が失敗したためバッチを停止しました${suffix}`;
}

export function buildConsecutiveFailureComment(
  failedTicketIds: readonly string[],
  lastFailureReason: string | null,
): string {
  const ids = failedTicketIds.join(', ');
  const reasonLine =
    lastFailureReason !== null && lastFailureReason.length > 0
      ? `最後の失敗理由: ${lastFailureReason}`
      : // Loop callers always pass a non-empty lastFailureReason; fallback for standalone use.
        '最後の失敗理由: （不明）';
  return `[harness] bdboard の一括実行（Next Up）で直近${NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES}件が失敗したためバッチを停止しました。\n失敗したチケット: ${ids}\n${reasonLine}`;
}
