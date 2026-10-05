/**
 * 文字列を書き換える唯一の場所 (bdboard-4y8q.2)。置換と、置換「後」の省略 (elide) だけを持つ。
 *
 * 順序の理由 (docs/ISSUE-REPORTING.md 4節・5節): エラー文はこの置換を全文にかけてから先頭・末尾へ切る。
 * 先に切ると、トークンが切れ目で半分になり (正規表現は 20 文字以上などを求める)、断片が残る。
 */
import { NO_EDGES, type FieldEdges } from './issue-public-fragments.js';
import type { PreparedKeys } from './issue-public-keys.js';
import {
  coverage,
  findKeyRedactionSpans,
  findRedactionSpans,
  findShapeRedactionSpans,
  mergeSpans,
  type KindSpan,
} from './issue-public-spans.js';
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
  fragment: '<redacted-fragment>',
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
 *
 * edges: 欄の端の断片 (保存の上限などで途中まで切れた名前・根・トークン。issue-public-fragments.ts) を探す端。1 回目と 2 回目の
 * どちらでも探す (名前が印に替わって直前が `>` になり、端の途中までの "sk-…" が開始の条件を満たすことがある)。
 *
 * 2 回目の、手元の鍵 (根と LONG の名前) の探索は、1 回目の印の周りの窓だけにかける (bdboard-uudb。鍵の探索は本文の長さ × 鍵の長さの
 * 合計に比例し、欄の端の断片だけで 2 回目が走ると全体が約 2 倍になっていた)。形の一致と端の断片は、線形なので全体にかける。
 * secondPass = 'full' は窓に絞らない版で、テストが同じ結果になることを確かめるためだけにある。
 */
export function redactText(
  text: string,
  prepared: PreparedKeys,
  edges: FieldEdges = NO_EDGES,
  secondPass: 'window' | 'full' = 'window',
): RedactedText {
  const first = applySpans(text, findRedactionSpans(text, prepared, edges));
  if (first.marks.length === 0) return first;
  const insideMark = coverage(first.marks);
  const keySpans =
    secondPass === 'full' ? findKeyRedactionSpans(first.text, prepared) : findKeySpansNearMarks(first.text, first.marks, prepared.keyReach, prepared);
  const fresh = [...keySpans, ...findShapeRedactionSpans(first.text, prepared, edges)].filter(
    (span) => !insideMark(span.start, span.end),
  );
  if (fresh.length === 0) return first;
  return applySpans(first.text, [...first.marks, ...fresh]);
}

/**
 * 2 回目の鍵の探索を、1 回目の印の周りの窓に絞る。窓に絞っても、全体を探したときと同じ一致の集合になる (論証):
 *
 *   記号: 1 回目の結果を T1、元の文字列を T0、鍵の一致の長さの上限を K (= 最長の鍵のコードポイント数 × 2 単位)、根が見る直後の文字を
 *   2 単位以下とし、R = K + 2 (PreparedKeys.keyReach) とする。鍵の一致 [s, e) が成り立つかは T[s, e) と、根なら直後の 1 文字
 *   (末尾ならその事実) だけで決まる (前は見ない)。
 *   (1) T1 での 2 回目の鍵の一致 c = [s, e) は、[s, e + 直後の文字) が 1 回目のどれかの印と重なる。重ならないとすると、その範囲は
 *       T0 のどこにも置き換えのなかった区間の写しなので、T0 の対応する位置でも同じ鍵が一致する。g の探索は左から重ならずに進むので、
 *       1 回目の同じ鍵の一致のどれかが c の写しと重なる (c の写しより前で終わる一致の次の探索は c の写し以前から始まり、c の写しか
 *       それより左の一致を見つける)。1 回目の一致はすべて印に置き換わるので、c の写しの中の文字が置き換わっていることになり、
 *       「置き換えのなかった区間の写し」と矛盾する。
 *   (2) よって c は、ある印 M について [M.start - R, M.end + R) (芯) の中にある (c の長さは K 以下、直後の文字は 2 単位以下)。
 *   (3) 窓 = 芯を左右に R ずつ広げたもの。重なる・接する窓はまとめる (芯も合わせて持つ)。窓の中で探すと、窓の外を見られないのは
 *       窓の右端の直後の文字だけ (前は見ないので左端は影響しない)。窓の右端で終わる一致は、窓の中の最後の芯の終わりより R - K > 0 だけ
 *       右から始まり、どの芯とも重ならない。T1 の本当の一致はどれも芯の中にあるので、窓の中の探索の「最後の芯の終わりより前から始まる
 *       一致」は、全体の探索のその窓の中の一致とちょうど同じになる (左から重ならずに進む順序も、本当の一致より前・間に偽の一致が入らないので変わらない。
 *       窓をまたぐ一致は (2) から無い)。
 *   全体の探索の一致は (2) からどれかの窓の中にあるので、窓ごとの一致を集めたものは全体の探索と同じ。形の一致 (トークン・メールなど) は
 *   長さに上限が無いものがあり、この論証が使えないので、窓に絞らず全体にかける (線形なので軽い)。
 */
function findKeySpansNearMarks(
  text: string,
  marks: readonly TextMark[],
  reach: number,
  prepared: PreparedKeys,
): KindSpan[] {
  const windows: { start: number; end: number; coreEnd: number }[] = [];
  for (const mark of marks) {
    const coreEnd = Math.min(text.length, mark.end + reach);
    const start = Math.max(0, mark.start - 2 * reach);
    const end = Math.min(text.length, mark.end + 2 * reach);
    const previous = windows.at(-1);
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      previous.coreEnd = Math.max(previous.coreEnd, coreEnd);
    } else windows.push({ start, end, coreEnd });
  }
  return windows.flatMap((window) =>
    findKeyRedactionSpans(text.slice(window.start, window.end), prepared)
      .map((span) => ({ kind: span.kind, start: span.start + window.start, end: span.end + window.start }))
      .filter((span) => span.start < window.coreEnd),
  );
}

/** 範囲を開始位置の順に並べ、重なるもの (接しているだけは別) を和集合にする。切れ目を 1 回の走査で境界へ動かすため。 */
function unionOf(ranges: readonly { readonly start: number; readonly end: number }[]): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || right.end - left.end)) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/**
 * 置換「後」の文字列を、先頭 headCodePoints と末尾 tailCodePoints コードポイントに省略する (切れ目はコードポイント単位で、
 * サロゲートの対を割らない)。収まるならそのまま返す。間には label(省略したコードポイント数) を入れる (固定の文言と数字。
 * label 自体は印ではない)。切れ目が印の内側に落ちるときは印の境界へ動かす (先頭側は印の始まり、末尾側は印の終わり)
 * ので、印が半分に割れない。省略した部分に完全に入る印は消え、後ろの印は位置をずらす。tail は 0 でもよい。
 *
 * avoid: 省略するときだけ呼ぶ、「切れ目を内側に落とさない範囲」を返す関数 (最後の網が報告する緩い一致。置き換えられなかったが
 * 疑わしい "id1sk-proj-…" が切れ目で短い断片になると、最後の網の長さの下限を割って、報告されないまま断片が残る)。
 * 印と同じ動かし方で、範囲ごと省略した側へ寄せるので、断片は公開本文に出ない。
 */
export function elide(
  redacted: RedactedText,
  headCodePoints: number,
  tailCodePoints: number,
  label: (omitted: number) => string,
  avoid: (text: string) => readonly { readonly start: number; readonly end: number }[] = () => [],
): RedactedText {
  if (codePointLength(redacted.text) <= headCodePoints + tailCodePoints) return redacted;
  let headEnd = codeUnitIndexAfterCodePoints(redacted.text, headCodePoints);
  let tailStart = codeUnitIndexBeforeTailCodePoints(redacted.text, tailCodePoints);
  for (const range of unionOf([...redacted.marks, ...avoid(redacted.text)])) {
    if (range.start < headEnd && headEnd < range.end) headEnd = range.start;
    if (range.start < tailStart && tailStart < range.end) tailStart = range.end;
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
