/**
 * 置き換えと最後の網が共有する「一致の集め方」 (bdboard-4y8q.2)。どの finder も同じ文字列を見て `{ kind, start, end }` を返す。
 *
 * 2 つの集め方がある (最後の網が置き換えと同じ finder だけだと、finder の穴は永久に見つからない — レビュー指摘):
 *   - findRedactionSpans: 置き換える一致。厳しめの形 (誤検出が少ない) と、LONG の固有名詞だけ。
 *   - findLeakSpans: 最後の網が報告する一致。置き換えと同じものに加えて、緩めた形 (sk-・Bearer・Stripe・JWT の直前の条件なし、
 *     小文字の akia、開始位置の条件なしの /Users/<名前>・/home/<名前>)・SHORT の固有名詞・鍵ブロックの単独の印。報告するだけで書き換えない。
 */
import { findEdgeFragmentSpans, NO_EDGES, type FieldEdges } from './issue-public-fragments.js';
import { findLooseHomeRanges, findPublicHomeRanges } from './issue-public-home.js';
import {
  findDetectableNounSpans,
  findProjectRootSpans,
  findReplaceableNounSpans,
  findShortNounSpans,
  type PreparedKeys,
} from './issue-public-keys.js';
import { findKeyBlockSpans } from './issue-public-pem.js';
import { findEmailSpans, findTokenSpans } from './issue-public-secrets.js';
import type { RedactionKind } from './issue-public-types.js';

export interface KindSpan {
  readonly kind: RedactionKind;
  readonly start: number;
  readonly end: number;
}

/**
 * 重なった一致を 1 つにまとめるとき、どの種別を残すか (大きいほど優先)。秘密 (鍵ブロック・トークン) が最優先:
 * 名前やパスを含む秘密が <project> や ~/ に見えると、人が見て「鍵があった」と分からない (中身はどちらも残らない)。
 * 次にパス (固有名詞より情報が多い)、固有名詞 (カテゴリが利用者に見える印になる)、メールの順。欄の端の断片 ('fragment') は
 * いちばん弱い: 完全な一致と重なったら、そちらの種別の印になる (完全なメールや JWT が欄の末尾にあるとき、断片の形にも一致するため)。
 */
export const PRIORITY: Readonly<Record<RedactionKind, number>> = {
  'key-block': 9,
  token: 8,
  'project-path': 7,
  'home-path': 6,
  project: 5,
  user: 4,
  host: 3,
  branch: 2,
  email: 1,
  fragment: 0,
};

type SpanSource = readonly { readonly start: number; readonly end: number }[];

function tagged(kind: RedactionKind, spans: SpanSource): KindSpan[] {
  return spans.map((span) => ({ kind, start: span.start, end: span.end }));
}

function common(text: string, prepared: PreparedKeys): KindSpan[] {
  return [
    ...tagged('project-path', findProjectRootSpans(text, prepared)),
    ...tagged('home-path', findPublicHomeRanges(text)),
    ...tagged('key-block', findKeyBlockSpans(text)),
    ...tagged('email', findEmailSpans(text)),
  ];
}

/**
 * 置き換える一致のうち、手元の鍵 (プロジェクトの根と LONG の固有名詞) の一致。どれも長さの決まった文字列の一致で、根が直後の
 * 1 文字を見るほかは前後を見ない (2 回目の置き換えを印の周りの窓に絞れる理由。issue-public-redact.ts)。
 */
export function findKeyRedactionSpans(text: string, prepared: PreparedKeys): KindSpan[] {
  return [...tagged('project-path', findProjectRootSpans(text, prepared)), ...findReplaceableNounSpans(text, prepared)];
}

/** 置き換える一致のうち、鍵を使わない分 (形の一致と、欄の端の断片)。どれも本文の長さに線形か、端だけを読む。 */
export function findShapeRedactionSpans(text: string, prepared: PreparedKeys, edges: FieldEdges = NO_EDGES): KindSpan[] {
  return [
    ...tagged('home-path', findPublicHomeRanges(text)),
    ...tagged('key-block', findKeyBlockSpans(text)),
    ...tagged('email', findEmailSpans(text)),
    ...tagged('token', findTokenSpans(text)),
    ...findEdgeFragmentSpans(text, prepared.fragmentKeys, edges),
  ];
}

/**
 * 置き換える一致 (統合は mergeSpans)。edges は欄の端の断片を探す端 (issue-public-fragments.ts。1 行の値は保存で切られないので
 * 既定は探さない)。
 */
export function findRedactionSpans(text: string, prepared: PreparedKeys, edges: FieldEdges = NO_EDGES): KindSpan[] {
  return [...findKeyRedactionSpans(text, prepared), ...findShapeRedactionSpans(text, prepared, edges)];
}

/** 最後の網が報告する一致 (置き換えの一致の上位集合。印の内側の分は呼び出し側が除く)。 */
export function findLeakSpans(text: string, prepared: PreparedKeys): KindSpan[] {
  const strictHome = coverage(findPublicHomeRanges(text));
  return [
    ...common(text, prepared),
    ...findDetectableNounSpans(text, prepared),
    ...tagged('token', findTokenSpans(text, true)),
    // 開始位置の条件で置き換えを見送った形 ("12:00:00/Users/jdoe/x")。置き換えの finder が見つけた分は二重に報告しない。
    ...tagged(
      'home-path',
      findLooseHomeRanges(text).filter((range) => !strictHome(range.start, range.end)),
    ),
  ];
}

/**
 * 最後の網の一致のうち、鍵 (プロジェクトの根・LONG の固有名詞) を使わない分: 緩めたトークン、開始位置の条件なしのホームのパス、
 * SHORT の固有名詞、鍵ブロックの単独の印、メール。省略の切れ目を避けるための探索 (issue-public-redact.ts の elide の avoid) に使う。
 * 置き換えは済んだ文字列にかけるので、根と LONG の名前はもう印の中にあり、探し直す必要がない。探し直すと、鍵の側の
 * O(n·m) (本文の長さ × 鍵の長さの合計) をもう一度払い、敵対的な鍵では省略する欄の時間が 1.5〜2 倍になる。
 */
export function findReportOnlySpans(text: string, prepared: PreparedKeys): KindSpan[] {
  const strictHomeRanges = findPublicHomeRanges(text);
  const strictHome = coverage(strictHomeRanges);
  return [
    ...tagged('home-path', strictHomeRanges),
    ...tagged('key-block', findKeyBlockSpans(text)),
    ...tagged('email', findEmailSpans(text)),
    ...tagged('token', findTokenSpans(text, true)),
    ...tagged(
      'home-path',
      findLooseHomeRanges(text).filter((range) => !strictHome(range.start, range.end)),
    ),
    ...findShortNounSpans(text, prepared),
  ];
}

/**
 * 開始位置の順 (同じなら長いものが先) に並べ、重なる一致を和集合に統合する。接しているだけ (終わり = 次の始まり) の
 * 一致は別のまま。統合した一致の種別は、PRIORITY が最も高いもの。
 */
export function mergeSpans(spans: readonly KindSpan[]): KindSpan[] {
  const sorted = [...spans].sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: KindSpan[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || span.start >= previous.end) {
      merged.push(span);
      continue;
    }
    merged[merged.length - 1] = {
      start: previous.start,
      end: Math.max(previous.end, span.end),
      kind: PRIORITY[span.kind] > PRIORITY[previous.kind] ? span.kind : previous.kind,
    };
  }
  return merged;
}

/**
 * 区間の被覆を二分探索で調べる。区間を開始位置の順に並べ、「その位置までの終了位置の最大値」を持っておけば、
 * 候補 [start, end) を覆う区間があるかは「start 以前に始まる区間の最大の終了位置 >= end」で決まる
 * (区間が重なっていても正しい)。区間が多い入力でも候補 1 件あたり O(log 区間の数)。
 */
export function coverage(ranges: readonly { readonly start: number; readonly end: number }[]): (start: number, end: number) => boolean {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const maxEnd: number[] = [];
  let running = -1;
  for (const range of sorted) {
    running = Math.max(running, range.end);
    maxEnd.push(running);
  }
  return (start, end) => {
    let low = 0;
    let high = sorted.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((sorted[middle]?.start ?? Number.POSITIVE_INFINITY) <= start) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found >= 0 && (maxEnd[found] ?? -1) >= end;
  };
}
