/**
 * 置き換え漏れの検出 (bdboard-4y8q.2、docs/ISSUE-REPORTING.md 5節「置き換え漏れの検出」)。
 * 置換の手順 (0)〜(3) から独立した最後の網: 完成した title / body の文字列に、置換と同じ finder を全部もう一度かけ、
 * 既存の印 (RedactionMark) の内側に収まらない一致をすべて報告する。置換が効いていれば何も出ない。出れば、正規表現の
 * 漏れ・文字種の違い・置換結果どうしの連結で新しくできた一致・置換しない設計の一致 (短い固有名詞の単語) のいずれか。
 *
 * - 印の内側の一致は報告しない: プロジェクト名がたまたま "email" や "project" のとき、置換後の `<email>` `<project>`
 *   の中身に一致してしまうのを避ける (印は置換した印の文字列そのものを覆う)。
 * - 印にまたがる・一部だけ重なる一致は報告する (印の外の文字が混じっている)。
 * - 一致は統合せずに 1 件ずつ、開始位置の順で返す。`matched` は最終文字列の切り出しそのもの。
 * - 判断はしない (best-effort)。人が見るための印付けで、唯一の防御ではない。
 */
import { findHomePathRanges } from './issue-draft-identifier.js';
import {
  findDetectableNounSpans,
  findProjectRootSpans,
  type PreparedKeys,
} from './issue-public-keys.js';
import { findEmailSpans, findPrivateKeySpans, findTokenSpans } from './issue-public-secrets.js';
import type { PublicField, RedactionKind, RedactionMark, SuspectedLeak } from './issue-public-types.js';

interface LeakCandidate {
  readonly kind: RedactionKind;
  readonly start: number;
  readonly end: number;
}

/**
 * 印の被覆を二分探索で調べる。印を開始位置の順に並べ、「その位置までの印の終了位置の最大値」を持っておけば、
 * 候補 [start, end) を覆う印があるかは「start 以前に始まる印の最大の終了位置 >= end」で決まる
 * (印が重なっていても正しい)。印が多い入力でも候補 1 件あたり O(log 印の数)。
 */
function coverage(marks: readonly RedactionMark[]): (start: number, end: number) => boolean {
  const sorted = [...marks].sort((left, right) => left.start - right.start);
  const maxEnd: number[] = [];
  let running = -1;
  for (const mark of sorted) {
    running = Math.max(running, mark.end);
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

export function detectSuspectedLeaks(
  field: PublicField,
  text: string,
  marks: readonly RedactionMark[],
  prepared: PreparedKeys,
): SuspectedLeak[] {
  const candidates: LeakCandidate[] = [
    ...findProjectRootSpans(text, prepared).map((span) => ({ ...span, kind: 'project-path' as const })),
    ...findHomePathRanges(text).map((span) => ({ ...span, kind: 'home-path' as const })),
    ...findDetectableNounSpans(text, prepared),
    ...findTokenSpans(text).map((span) => ({ ...span, kind: 'token' as const })),
    ...findPrivateKeySpans(text).map((span) => ({ ...span, kind: 'key-block' as const })),
    ...findEmailSpans(text).map((span) => ({ ...span, kind: 'email' as const })),
  ];
  const covered = coverage(marks.filter((mark) => mark.field === field));
  return candidates
    .filter((candidate) => !covered(candidate.start, candidate.end))
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map((candidate) => ({ ...candidate, field, matched: text.slice(candidate.start, candidate.end) }));
}
