/**
 * 文字列を書き換える唯一の場所 (bdboard-4y8q.2)。置換と、置換「後」の省略 (elide) だけを持つ。
 *
 * 順序の理由 (docs/ISSUE-REPORTING.md 4節・5節): エラー文はこの置換を全文にかけてから先頭・末尾へ切る。
 * 先に切ると、トークンが切れ目で半分になり (正規表現は 20 文字以上などを求める)、断片が残る。
 */
import type { PreparedKeys } from './issue-public-keys.js';
import { coverage, findRedactionSpans, mergeSpans, type KindSpan } from './issue-public-spans.js';
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

/** 一致を統合し、左から 1 回の走査で印に置き換える。返す marks は出力 (text) の上での印の位置。 */
function applySpans(text: string, spans: readonly KindSpan[]): RedactedText {
  let sourceOffset = 0;
  let output = '';
  const marks: TextMark[] = [];
  for (const span of mergeSpans(spans)) {
    output += text.slice(sourceOffset, span.start);
    const start = output.length;
    output += PLACEHOLDER[span.kind];
    marks.push({ kind: span.kind, start, end: output.length });
    sourceOffset = span.end;
  }
  return { text: output + text.slice(sourceOffset), marks };
}

/**
 * すべての finder を「同じ入力文字列」にかけて一致を集め、統合し、左から 1 回の走査で印に置き換える (1 回目)。
 * finder が同じ文字列を見るので、後の規則が先の規則の印の中に一致することはない。
 *
 * 2 回目 (最大 2 回): 1 回目の結果にもう一度 finder をかける。固有名詞やパスが印に替わると、直前の文字が `>` や `/` に
 * 変わり、それまで直前が英数字だったために見送られた一致が新しく現れる ("example-project" + "sk-proj-…" が
 * "<project>sk-proj-…" になる、"example-project/Users/jdoe/x" が "<project>/Users/jdoe/x" になる)。
 * 2 回目の一致のうち、1 回目の印の内側に収まるもの (名前がたまたま "project" のときの "<project>" の中身など) は捨て、
 * 残りは 1 回目の印と一緒に統合し直す (印にまたがる一致は和集合になる)。印の位置は、統合し直した結果の位置。
 * 1 回目で何も見つからなければ文字列は変わっていないので、2 回目はしない。3 回目以降は、最後の網が報告する。
 * 返す marks は出力 (text) の上での印の位置で、開始位置の順・重なりなし。
 */
export function redactText(text: string, prepared: PreparedKeys): RedactedText {
  const first = applySpans(text, findRedactionSpans(text, prepared));
  if (first.marks.length === 0) return first;
  const insideMark = coverage(first.marks);
  const fresh = findRedactionSpans(first.text, prepared).filter((span) => !insideMark(span.start, span.end));
  if (fresh.length === 0) return first;
  return applySpans(first.text, [...first.marks, ...fresh]);
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
