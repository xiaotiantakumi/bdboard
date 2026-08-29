/**
 * まとめて引く処理の中で「1件失敗しても全体は続ける」箇所の、失敗の言い分け
 * (bdboard-fxxk)。
 *
 * getPendingCommentAnchors / getPrBadges はどちらも bd を1チケットずつ叩き、
 * 失敗したチケットを黙って飛ばす。飛ばすこと自体は正しい (1件のために画面全部を
 * 落とすほうが悪い) が、握り潰したままだと、その結果として出る誤り —
 * 議論中のチケットが「放置された確認待ち」に出る / PRバッジが消える — の原因を
 * 追う手掛かりがゼロになる。実際 bd comments は単発で中央値1.7秒・最悪46秒
 * かかることがあり (2026-08-29 実測、並行セッションによる Dolt ロック競合下)、
 * 30秒でタイムアウトする呼び出しも観測されている。
 *
 * ただし**失敗ごとに1行出してはいけない**。bd が丸ごと壊れているときは対象の
 * 全チケットが失敗するので、getPrBadges なら1リクエストで数百行になる。
 * 呼び出し1回につき1行にまとめる。
 */
export interface FetchFailure {
  /** 失敗した対象の識別子 (チケットID や PR URL)。 */
  readonly id: string;
  readonly error: unknown;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

/**
 * 失敗の要約を1行で返す。件数と、代表として最初の1件だけを出す
 * (全部出すと結局まとめた意味が無い)。
 *
 * @param failures 失敗した対象。空なら呼び出し側がログ自体を出さないこと。
 * @param total 試行した総数。分母が無いと「全滅」と「1件だけ」が区別できない。
 */
export function describeFetchFailures(
  failures: readonly FetchFailure[],
  total: number,
): string {
  const first = failures[0];
  const head = `${failures.length} of ${total} failed.`;
  if (first === undefined) {
    return head;
  }
  return `${head} First failure: ${first.id}: ${describeError(first.error)}`;
}
