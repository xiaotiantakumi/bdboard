/**
 * 手元の鍵 (プロジェクトの根・LONG の固有名詞) の出現を本文から探す (bdboard-0hj9、docs/ISSUE-REPORTING.md 5節「自分と重なる鍵」)。
 * 鍵のたたみ方と表は issue-public-casefold.ts。ここは「たたんだ本文の上で、どの範囲を一致とするか」だけを持つ。
 *
 * 鍵が自分と重なる (`-ba1-ba1-ba` のように先頭と末尾が同じ部分を持つ周期的な綴り) とき、以前は一致の終わりから次を探したので、欄の途中で
 * 2 つの出現が重なって現れると 2 つ目を拾えず、その後ろが残った (`log: -ba1-ba1-ba1-ba done` → `<project>1-ba done`)。今は鍵のすべての出現
 * (自分と重なるものを含む) を探し、厳密に重なる出現は 1 つの範囲に併合する (接しているだけの出現は別の範囲のまま。周期的でない鍵では以前と同じ結果)。
 *
 * 線形時間: `indexOf` で最初の出現を見つけたら、そこから KMP (鍵の失敗関数) で本文を読み進めて重なる出現を拾い、状態が 0 に戻ったら (重なりうる
 * 出現が無い) `indexOf` に戻る。KMP が読むのは出現の後ろだけで各位置は高々 1 回なので、鍵 1 つあたり O(本文の長さ + 鍵の長さ)。失敗関数は
 * 一致のあった鍵だけが作る (記憶量)。以前は根が直後の文字の条件で外れるたびに 1 つ右から探し直していた (周期的な根で 2 乗)。
 */
import { foldedTextOf, type CaseInsensitiveLiteral } from './issue-public-casefold.js';

export interface LiteralSpan {
  readonly start: number;
  readonly end: number;
}

interface MutableSpan {
  start: number;
  end: number;
}

/** 根の直後に来てはいけない文字 (以前の根の正規表現の先読み `(?![\p{L}\p{N}_-])` と同じ。i つきなので閉包も同じ)。 */
const ROOT_FOLLOWER = /[\p{L}\p{N}_-]/iuy;

const failures = new WeakMap<CaseInsensitiveLiteral, Int32Array>();

/** KMP の失敗関数: failure[i] は key.folded[0..i] の、全体より短い前置部分で後置部分でもあるものの最長の長さ (UTF-16 のコード単位)。 */
function failureOf(key: CaseInsensitiveLiteral): Int32Array {
  const cached = failures.get(key);
  if (cached !== undefined) return cached;
  const pattern = key.folded;
  const failure = new Int32Array(pattern.length);
  for (let index = 1, state = 0; index < pattern.length; index += 1) {
    const unit = pattern.charCodeAt(index);
    while (state > 0 && unit !== pattern.charCodeAt(state)) state = failure[state - 1] ?? 0;
    if (unit === pattern.charCodeAt(state)) state += 1;
    failure[index] = state;
  }
  failures.set(key, failure);
  return failure;
}

/** 出現を開始位置の順に足す。前の範囲と厳密に重なるなら 1 つに併合する (接しているだけは別)。 */
function addOccurrence(spans: MutableSpan[], start: number, end: number): void {
  const previous = spans.at(-1);
  if (previous !== undefined && start < previous.end) previous.end = Math.max(previous.end, end);
  else spans.push({ start, end });
}

/** 表が使えるとき: たたんだ本文の上で、indexOf と KMP の読み進めを交互に使って、すべての出現を集める。 */
function foldedSpans(folded: string, key: CaseInsensitiveLiteral, allows: ((end: number) => boolean) | undefined): LiteralSpan[] {
  const pattern = key.folded;
  const length = pattern.length;
  const spans: MutableSpan[] = [];
  if (length === 0) return spans;
  let from = folded.indexOf(pattern);
  while (from !== -1) {
    const failure = failureOf(key);
    let end = from + length;
    for (;;) {
      // 根は出現ごとに直後の文字の条件を見る。外れた出現は範囲に入れないが、KMP は続ける (外れた出現と重なる別の出現を見落とさない)。
      if (allows === undefined || allows(end)) addOccurrence(spans, end - length, end);
      let state = failure[length - 1] ?? 0;
      while (state < length && end < folded.length) {
        const unit = folded.charCodeAt(end);
        if (unit === pattern.charCodeAt(state)) {
          state += 1;
          end += 1;
        } else if (state > 0) state = failure[state - 1] ?? 0;
        else break;
      }
      if (state < length) break;
    }
    // 状態 0 (または本文の終わり): ここまでに重なりうる出現は無い。次の出現は end 以降。
    from = folded.indexOf(pattern, end);
  }
  return spans;
}

/** 表が使えないエンジン: 先読みの捕獲 `(?=(鍵)…)` で、重なる出現もすべて集めて併合する (遅いが同じ結果)。 */
function fallbackSpans(text: string, pattern: RegExp): LiteralSpan[] {
  pattern.lastIndex = 0;
  const spans: MutableSpan[] = [];
  for (const match of text.matchAll(pattern)) addOccurrence(spans, match.index, match.index + (match[1]?.length ?? 0));
  return spans;
}

/**
 * 本文 1 つに対して鍵を探す関数を返す (本文のたたみは最初の 1 回だけ)。返す範囲は本文の UTF-16 の半開区間で、左から重ならない
 * (出現が重なるときは併合してある)。
 */
export function literalSearcher(text: string): (key: CaseInsensitiveLiteral) => LiteralSpan[] {
  let folded: string | undefined;
  // 根の直後の文字の条件の結果を、位置ごとに覚えて鍵の間で共有する (0: 未検査、1: 外れる、2: 通る)。周期的な根は出現が O(n) 件になるので、
  // sticky の正規表現を毎回呼ばない。
  let followers: Uint8Array | undefined;
  const followerAllows = (end: number): boolean => {
    followers ??= new Uint8Array(text.length + 1);
    let state = followers[end] ?? 0;
    if (state === 0) {
      ROOT_FOLLOWER.lastIndex = end;
      state = ROOT_FOLLOWER.test(text) ? 1 : 2;
      followers[end] = state;
    }
    return state === 2;
  };
  return (key) => {
    if (text.length < key.codePoints) return [];
    if (key.fallback !== undefined) return fallbackSpans(text, key.fallback);
    folded ??= foldedTextOf(text);
    return foldedSpans(folded, key, key.root ? followerAllows : undefined);
  };
}
