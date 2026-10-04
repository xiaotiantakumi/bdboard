/**
 * 文字列を書き換える唯一の場所 (bdboard-4y8q.2)。置換と、置換「後」の省略 (elide) だけを持つ。
 *
 * 順序の理由 (docs/ISSUE-REPORTING.md 4節・5節): エラー文はこの置換を全文にかけてから先頭・末尾へ切る。
 * 先に切ると、トークンが切れ目で半分になり (正規表現は 20 文字以上などを求める)、断片が残る。
 */
import { findHomePathRanges } from './issue-draft-identifier.js';
import {
  findProjectRootSpans,
  findReplaceableNounSpans,
  type PreparedKeys,
} from './issue-public-keys.js';
import { findEmailSpans, findPrivateKeySpans, findTokenSpans } from './issue-public-secrets.js';
import {
  codePointLength,
  codeUnitIndexAfterCodePoints,
  codeUnitIndexBeforeTailCodePoints,
} from './issue-public-text.js';
import type { RedactionKind } from './issue-public-types.js';

/** 置換後の文字列の中の、印 (placeholder) の位置。start/end は text への UTF-16 オフセット (半開区間)。 */
export interface TextMark {
  readonly kind: RedactionKind;
  readonly start: number;
  readonly end: number;
}

export interface RedactedText {
  readonly text: string;
  readonly marks: readonly TextMark[];
}

/**
 * 重なった一致を 1 つにまとめるとき、どの種別を残すか (大きいほど優先)。
 * パスで残すほうが固有名詞より情報が多く、固有名詞はカテゴリが利用者に見える印になる。秘密の形は最後。
 */
const PRIORITY: Readonly<Record<RedactionKind, number>> = {
  'project-path': 9,
  'home-path': 8,
  project: 7,
  user: 6,
  host: 5,
  branch: 4,
  'key-block': 3,
  token: 2,
  email: 1,
};

/** 種別ごとの印。`~/` は foldHomePaths と同じ (ユーザー名とその後ろの区切りを置き換える)。 */
const PLACEHOLDER: Readonly<Record<RedactionKind, string>> = {
  'project-path': '<project>',
  'home-path': '~/',
  project: '<project>',
  user: '<user>',
  host: '<host>',
  branch: '<branch>',
  'key-block': '<redacted-key-block>',
  token: '<redacted-token>',
  email: '<email>',
};

/**
 * 開始位置の順 (同じなら長いものが先) に並べ、重なる一致を和集合に統合する。接しているだけ (終わり = 次の始まり) の
 * 一致は別のまま。統合した一致の種別は、PRIORITY が最も高いもの。
 */
function mergeSpans(spans: readonly TextMark[]): TextMark[] {
  const sorted = [...spans].sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: TextMark[] = [];
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
 * すべての finder を「同じ入力文字列」にかけて一致を集め、統合し、左から 1 回の走査で印に置き換える。
 * finder が同じ文字列を見るので、後の規則が先の規則の印の中に一致することはない。
 * 返す marks は出力 (text) の上での印の位置で、開始位置の順・重なりなし。
 */
export function redactText(text: string, prepared: PreparedKeys): RedactedText {
  const spans: TextMark[] = [
    ...findProjectRootSpans(text, prepared).map((span) => ({ ...span, kind: 'project-path' as const })),
    ...findHomePathRanges(text).map((span) => ({ ...span, kind: 'home-path' as const })),
    ...findReplaceableNounSpans(text, prepared),
    ...findPrivateKeySpans(text).map((span) => ({ ...span, kind: 'key-block' as const })),
    ...findTokenSpans(text).map((span) => ({ ...span, kind: 'token' as const })),
    ...findEmailSpans(text).map((span) => ({ ...span, kind: 'email' as const })),
  ];
  let sourceOffset = 0;
  let output = '';
  const marks: TextMark[] = [];
  for (const span of mergeSpans(spans)) {
    output += text.slice(sourceOffset, span.start);
    const placeholder = PLACEHOLDER[span.kind];
    const start = output.length;
    output += placeholder;
    marks.push({ kind: span.kind, start, end: output.length });
    sourceOffset = span.end;
  }
  return { text: output + text.slice(sourceOffset), marks };
}

/**
 * 置換「後」の文字列を、先頭 headCodePoints と末尾 tailCodePoints コードポイントに省略する (切れ目はコードポイント単位で、
 * サロゲートの対を割らない)。収まるならそのまま返す。間には label(省略したコードポイント数) を入れる (固定の文言と数字。
 * label 自体は印ではない)。切れ目が印の内側に落ちるときは印の境界へ動かす (先頭側は印の始まり、末尾側は印の終わり)
 * ので、印が半分に割れない。省略した部分に完全に入る印は消え、後ろの印は位置をずらす。tail は 0 でもよい。
 */
export function elide(
  redacted: RedactedText,
  headCodePoints: number,
  tailCodePoints: number,
  label: (omitted: number) => string,
): RedactedText {
  if (codePointLength(redacted.text) <= headCodePoints + tailCodePoints) return redacted;
  let headEnd = codeUnitIndexAfterCodePoints(redacted.text, headCodePoints);
  let tailStart = codeUnitIndexBeforeTailCodePoints(redacted.text, tailCodePoints);
  for (const mark of redacted.marks) {
    if (mark.start < headEnd && headEnd < mark.end) headEnd = mark.start;
    if (mark.start < tailStart && tailStart < mark.end) tailStart = mark.end;
  }
  const middle = label(codePointLength(redacted.text.slice(headEnd, tailStart)));
  const shift = headEnd + middle.length - tailStart;
  const marks = redacted.marks.flatMap((mark) => {
    if (mark.end <= headEnd) return [mark];
    if (mark.start >= tailStart) return [{ ...mark, start: mark.start + shift, end: mark.end + shift }];
    return [];
  });
  return { text: redacted.text.slice(0, headEnd) + middle + redacted.text.slice(tailStart), marks };
}
