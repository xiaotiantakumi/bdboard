/**
 * 欄の端の断片 (bdboard-4y8q.13、docs/ISSUE-REPORTING.md 5節「欄の端の断片」)。
 *
 * 保存の上限 (4節) と、末尾だけを取る送り手 (tail-capture) は、欄を途中で切りうる。保存側は切れ目を行の境目へ戻すが
 * (issue-draft-cut.ts)、近くに改行の無い長い行では行の途中で切る。その切れ目が公開本文の欄の端になり、名前・根・トークンの
 * 途中で切れた断片 ("/work/example-proj"・"ghp_" + 15 文字・頭の欠けた "ample-project/src") は、完全な形を探す置き換えに
 * 一致しない。ここは欄の端だけを見て、断片を置き換えの一致 (種別 'fragment'、印は <redacted-fragment>) として返す:
 *   - 末尾: プロジェクトの根・LONG の固有名詞 (変種を含む) の、4 コードポイント以上で全体より短い前置部分。TOKEN_PREFIX_AT_END の
 *     途中までのトークン。ローカル部と "@" から始まる途中までのメール。
 *   - 先頭 (呼び出し側が start を立てた欄だけ。末尾だけを取る送り手がいるのはエラー文): 根・LONG の固有名詞の、4 コードポイント以上で
 *     全体より短い後置部分。先頭が欠けたトークンは本体だけが残り、形が無いので拾えない (5節「カバーしないもの」)。
 * 全体に一致するもの (全体より短くない) は、先頭の端ではここで返さない: 通常の置き換えが拾い、根の直後の文字の条件 (example-project2) も
 * そちらが持つ。末尾の端では返す (直後の文字が無く、通常の置き換えの一致と重なれば統合で強い種別の印 1 つになる。bdboard-2ydj の時点では、
 * 本体が重ならずに探していたので、自分と重なる名前が末尾で重なって 2 回現れると 2 つ目を拾えず、この返し方がその穴を塞いでいた。今は本体が
 * 重なる出現も探す (bdboard-0hj9) ので、ここは二重の網になる)。
 *
 * 大文字小文字: 各コードポイントを、本体の探索と同じ表 (issue-public-casefold.ts) の代表にたたんで比べる。表が使えないエンジンでは、
 * エンジンに直接尋ねて同じ同値類にたたむ。以前は toLowerCase で、µ/μ・ς/σ・ϑ/θ・ſ/s・U+1FBE/ι が本体と端で別だった。
 * prepareKeys は検索の鍵をまとめても、変種はすべてここの鍵に渡す。鍵ごとに KMP の失敗関数を前もって作り、欄の端から鍵の長さぶんだけを読むので、
 * 鍵 1 つあたり O(鍵の長さ) で、欄の長さによらない。
 */
import { findEmailPrefixAtEnd, findTokenPrefixesAtEnd } from './issue-public-secrets.js';
import { foldCodePoint } from './issue-public-casefold.js';
import { codeUnitIndexAfterCodePoints, codeUnitIndexBeforeTailCodePoints } from './issue-public-text.js';

/** これより短い断片は置き換えない (固有名詞の LONG の下限と同じ。2〜3 文字では元の名前を特定できず、一般語を壊す)。 */
export const MIN_FRAGMENT_CODE_POINTS = 4;

/**
 * 端の検査の鍵の合計コードポイント数の上限 (prepareKeys が数える。超えた鍵は端の検査に使わず、truncated を立てる)。
 * 鍵 1 コードポイントあたり、前向き・逆向きの並びと 2 つの失敗関数で数十バイトを持つ。根の変種 (区切り・NFC/NFD・パーセント表記) は
 * 1 つの根を数十倍に広げるので、上限が無いと、根 200 件 × 1024 コードポイントの非 ASCII の鍵で数百 MB〜GB になる (5節)。
 * 現実の鍵 (根と名前が数十件、各 100 コードポイント程度) は数万コードポイントで、この上限に届かない。
 */
export const MAX_FRAGMENT_KEY_CODE_POINTS = 2_000_000;

/** どちらの端を見るか。保存の上限で切れるのは末尾、末尾だけを取る送り手で切れるのは先頭。 */
export interface FieldEdges {
  readonly start: boolean;
  readonly end: boolean;
}

export const NO_EDGES: FieldEdges = Object.freeze({ start: false, end: false });

/** 端の検査に使う鍵 1 つ (根か LONG の固有名詞の変種 1 つ)。たたんだコードポイントの並びと、その KMP の失敗関数。 */
export interface FragmentKey {
  readonly forward: readonly string[];
  readonly forwardFailure: readonly number[];
  /** forward を逆順にしたもの (先頭の後置部分を、逆順の前置部分として探す)。 */
  readonly backward: readonly string[];
  readonly backwardFailure: readonly number[];
}

export interface FragmentSpan {
  readonly kind: 'fragment';
  readonly start: number;
  readonly end: number;
}

/** KMP の失敗関数: failure[i] は pattern[0..i] の、全体より短い前置部分で後置部分でもあるものの最長の長さ。 */
function failureOf(pattern: readonly string[]): number[] {
  const failure: number[] = new Array<number>(pattern.length).fill(0);
  let matched = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = failure[matched - 1] ?? 0;
    if (pattern[index] === pattern[matched]) matched += 1;
    failure[index] = matched;
  }
  return failure;
}

function keyOf(forward: readonly string[]): FragmentKey {
  const backward = [...forward].reverse();
  return { forward, forwardFailure: failureOf(forward), backward, backwardFailure: failureOf(backward) };
}

export function toFragmentKey(value: string): FragmentKey {
  return keyOf(Array.from(value, foldCodePoint));
}

/** 端の検査の鍵を集める (prepareKeys)。たたんだ後で同じになる鍵は 1 つにし、合計のコードポイント数を上限までに抑える。 */
export interface FragmentKeyCollector {
  /** 鍵を足す。たたんだ後で同じ鍵がもうあれば何もしない。上限を超えるなら足さずに false を返す (呼び出し側が truncated を立てる)。 */
  add(value: string): boolean;
  readonly keys: readonly FragmentKey[];
}

export function fragmentKeyCollector(maxCodePoints: number = MAX_FRAGMENT_KEY_CODE_POINTS): FragmentKeyCollector {
  const keys: FragmentKey[] = [];
  const seen = new Set<string>();
  let total = 0;
  return {
    keys,
    add(value) {
      const forward = Array.from(value, foldCodePoint);
      const id = forward.join('\u0000');
      // 重複を先に見る: 上限の直前でも、すでにある鍵と同じ変種 (大小文字だけ違う根など) では truncated を立てない。
      if (seen.has(id)) return true;
      if (total + forward.length > maxCodePoints) return false;
      seen.add(id);
      total += forward.length;
      keys.push(keyOf(forward));
      return true;
    },
  };
}

/**
 * 並び (length 個、at(i) で i 番目) を読み終えたとき、その末尾と pattern の先頭が重なる最長の長さ (pattern の長さ以下)。
 */
function overlapAtEnd(
  length: number,
  at: (index: number) => string,
  pattern: readonly string[],
  failure: readonly number[],
): number {
  let matched = 0;
  for (let index = 0; index < length; index += 1) {
    const unit = at(index);
    while (matched > 0 && (matched === pattern.length || pattern[matched] !== unit)) matched = failure[matched - 1] ?? 0;
    if (matched < pattern.length && pattern[matched] === unit) matched += 1;
  }
  return matched;
}

/** 端の窓: 文字列の端の最大 maxCodePoints コードポイント (たたんだもの) と、各コードポイントの UTF-16 の長さ。 */
interface EdgeWindow {
  readonly folded: readonly string[];
  readonly units: readonly number[];
}

function windowOf(points: readonly string[]): EdgeWindow {
  return { folded: points.map(foldCodePoint), units: points.map((point) => point.length) };
}

function sumUnits(units: readonly number[], from: number, to: number): number {
  let total = 0;
  for (let index = from; index < to; index += 1) total += units[index] ?? 0;
  return total;
}

function longestKey(keys: readonly FragmentKey[]): number {
  return keys.reduce((longest, key) => Math.max(longest, key.forward.length), 0);
}

type Range = { readonly start: number; readonly end: number };

/** 末尾: 鍵の、全体より短い前置部分で終わるもの。 */
function keyPrefixesAtEnd(text: string, keys: readonly FragmentKey[]): Range[] {
  const tail = windowOf(Array.from(text.slice(codeUnitIndexBeforeTailCodePoints(text, longestKey(keys)))));
  const spans: Range[] = [];
  for (const key of keys) {
    const read = Math.min(tail.folded.length, key.forward.length);
    const offset = tail.folded.length - read;
    const overlap = overlapAtEnd(read, (index) => tail.folded[offset + index] ?? '', key.forward, key.forwardFailure);
    // 末尾では、鍵の全体の一致も返す (overlap === 鍵の長さ)。末尾には直後の文字が無いので、根の条件 (example-project2) と矛盾しない。
    // 本体の探索は、自分と重なる名前 (-ba1-ba1-ba) が重なって 2 回現れても両方を探す (bdboard-0hj9。それまでは重ならずに探して、末尾で
    // 2 つ目を拾わず後ろが残っていた)。ここで全体の一致も返すのは二重の網: 本体の一致と重なれば、統合 (mergeSpans) で強い種別の印 1 つになるので、
    // ふつうの入力の出力は変わらない。
    if (overlap < MIN_FRAGMENT_CODE_POINTS) continue;
    const length = sumUnits(tail.units, tail.units.length - overlap, tail.units.length);
    spans.push({ start: text.length - length, end: text.length });
  }
  return spans;
}

/** 先頭: 鍵の、全体より短い後置部分で始まるもの (逆順にして、前置部分として探す)。 */
function keySuffixesAtStart(text: string, keys: readonly FragmentKey[]): Range[] {
  const head = windowOf(Array.from(text.slice(0, codeUnitIndexAfterCodePoints(text, longestKey(keys)))));
  const spans: Range[] = [];
  for (const key of keys) {
    const read = Math.min(head.folded.length, key.backward.length);
    const overlap = overlapAtEnd(read, (index) => head.folded[read - 1 - index] ?? '', key.backward, key.backwardFailure);
    if (overlap < MIN_FRAGMENT_CODE_POINTS || overlap >= key.backward.length) continue;
    spans.push({ start: 0, end: sumUnits(head.units, 0, overlap) });
  }
  return spans;
}

/**
 * 欄の端の断片の範囲 (UTF-16 の半開区間、種別は 'fragment')。text は置き換えに渡すのと同じ整形後の文字列。
 * 範囲どうしや、通常の置き換えの一致とは重なりうる (統合は issue-public-spans.ts の mergeSpans。'fragment' はいちばん弱い)。
 */
export function findEdgeFragmentSpans(text: string, keys: readonly FragmentKey[], edges: FieldEdges): FragmentSpan[] {
  if (text === '') return [];
  const spans: Range[] = [];
  if (edges.end) {
    spans.push(...keyPrefixesAtEnd(text, keys), ...findTokenPrefixesAtEnd(text), ...findEmailPrefixAtEnd(text));
  }
  if (edges.start) spans.push(...keySuffixesAtStart(text, keys));
  return spans.map((span) => ({ kind: 'fragment', start: span.start, end: span.end }));
}
