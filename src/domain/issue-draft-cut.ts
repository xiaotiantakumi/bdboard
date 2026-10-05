/**
 * 保存側の切り詰め (bdboard-4y8q.13、docs/ISSUE-REPORTING.md 4節「上限」・5節「欄の端の断片」)。
 *
 * 上限で切るとき、切れ目を行の境目へ戻す。先頭を残す切り詰め (保存の上限) は上限の内側の最後の改行の直後まで、
 * 末尾を残す切り詰め (tail-capture) は最初の不完全な行を捨てる。切れ目はそのまま公開本文の欄の端になる (公開本文は
 * エラー文の先頭と末尾の 1000 コードポイントを見せる) ので、名前・根・トークンの途中で切ると、置き換えの形に一致しない
 * 断片 ("/work/example-proj"・"ghp_" + 15 文字・頭の欠けた "ample-project/src") が素通りする。
 *
 * 戻る距離は CUT_LINE_BACKOFF_MAX_CHARS まで。それより長い行 (改行の無い 1 行の欄も) では、行を丸ごと捨てずに
 * コードポイントの境目で切る。そのとき欄の端に残る断片は、公開本文の側の端の検査 (issue-public-fragments.ts) が拾う。
 * どちらの場合もサロゲートの対は割らない。長さは今までどおり UTF-16 のコード単位で数え、結果は必ず上限以下
 * (200KB の判定と保持期限の合計容量は、欄が短くなる向きにしか変わらない)。
 */

/** 行の境目を探して戻る最大の距離 (UTF-16 コード単位)。スタックトレースやログの 1 行はふつうこれより短い。 */
export const CUT_LINE_BACKOFF_MAX_CHARS = 4096;

/** 公開本文の整形 (issue-public-text.ts の normalizeBlock) が行の区切りとして扱う文字と同じ: \n \r \v \f U+0085 U+2028 U+2029。 */
function isLineBreak(unit: number): boolean {
  return (
    unit === 0x0a || unit === 0x0d || unit === 0x0b || unit === 0x0c || unit === 0x85 || unit === 0x2028 || unit === 0x2029
  );
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * 先頭を残して maxUnits コード単位以下にする。上限の内側に改行があれば (CUT_LINE_BACKOFF_MAX_CHARS の範囲で) その直後で切り、
 * 不完全な最後の行を残さない。無ければコードポイントの境目で切る。収まっていればそのまま返す。
 */
export function cutKeepingHead(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = Math.max(0, maxUnits);
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  // 切れ目の直後が改行なら、残す側は行の終わりで終わっている。
  if (isLineBreak(text.charCodeAt(end))) return text.slice(0, end);
  const floor = Math.max(0, end - CUT_LINE_BACKOFF_MAX_CHARS);
  for (let index = end - 1; index >= floor; index -= 1) {
    if (isLineBreak(text.charCodeAt(index))) return text.slice(0, index + 1);
  }
  return text.slice(0, end);
}

/**
 * 末尾を残して maxUnits コード単位以下にする (tail-capture)。最初の不完全な行は (CUT_LINE_BACKOFF_MAX_CHARS の範囲で) 捨てる。
 * 範囲に改行が無ければコードポイントの境目で切る。収まっていればそのまま返す。
 */
export function cutKeepingTail(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let start = text.length - Math.max(0, maxUnits);
  if (start < text.length && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start += 1;
  // 切れ目の直前が改行なら、残す側は行の始まりから始まっている。CRLF の間で切れたら LF も捨てる (残す側を空行で始めない)。
  if (isLineBreak(text.charCodeAt(start - 1))) {
    const crlf = text.charCodeAt(start - 1) === 0x0d && text.charCodeAt(start) === 0x0a;
    return text.slice(crlf ? start + 1 : start);
  }
  const ceiling = Math.min(text.length, start + CUT_LINE_BACKOFF_MAX_CHARS);
  for (let index = start; index < ceiling; index += 1) {
    if (!isLineBreak(text.charCodeAt(index))) continue;
    // CRLF は 2 文字まとめて捨てる (残す側を空行で始めない)。
    const next = text.charCodeAt(index) === 0x0d && text.charCodeAt(index + 1) === 0x0a ? index + 2 : index + 1;
    return text.slice(next);
  }
  return text.slice(start);
}
