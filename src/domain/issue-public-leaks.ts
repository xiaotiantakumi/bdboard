/**
 * 置き換え漏れの検出 (bdboard-4y8q.2、docs/ISSUE-REPORTING.md 5節「置き換え漏れの検出」)。
 * 置換の手順 (0)〜(3) から独立した最後の網: 完成した title / body の文字列に、置換と同じ finder と、緩めた報告専用の finder
 * (issue-public-spans.ts の findLeakSpans) をかけ、既存の印 (RedactionMark) の内側に収まらない一致をすべて報告する。
 * 置換が効いていれば何も出ない。出れば、置換の形の穴 (緩めた形だけが見つけた、直前に英数字が貼り付いた sk-・Bearer、
 * 小文字の akia など)・文字種の違い・置換結果どうしの連結で新しくできた一致 (2 回の置き換えでも消えなかったもの)・
 * 置換しない設計の一致 (短い固有名詞の単語) のいずれか。
 *
 * - 印の内側の一致は報告しない: プロジェクト名がたまたま "email" や "project" のとき、置換後の `<email>` `<project>`
 *   の中身に一致してしまうのを避ける (印は置換した印の文字列そのものを覆う)。
 * - 印にまたがる・一部だけ重なる一致は報告する (印の外の文字が混じっている)。
 * - 鍵ブロックの BEGIN/END の印は、単独でも報告する (issue-public-pem.ts: 印はどれかのブロックの内側に入る)。
 * - 一致は統合せずに 1 件ずつ、開始位置の順で返す。`matched` は最終文字列の切り出しそのもの。
 * - 判断はしない (best-effort)。人が見るための印付けで、唯一の防御ではない。
 */
import type { PreparedKeys } from './issue-public-keys.js';
import { coverage, findLeakSpans } from './issue-public-spans.js';
import type { PublicField, RedactionMark, SuspectedLeak } from './issue-public-types.js';

export function detectSuspectedLeaks(
  field: PublicField,
  text: string,
  marks: readonly RedactionMark[],
  prepared: PreparedKeys,
): SuspectedLeak[] {
  const covered = coverage(marks.filter((mark) => mark.field === field));
  return findLeakSpans(text, prepared)
    .filter((candidate) => !covered(candidate.start, candidate.end))
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map((candidate) => ({ ...candidate, field, matched: text.slice(candidate.start, candidate.end) }));
}
