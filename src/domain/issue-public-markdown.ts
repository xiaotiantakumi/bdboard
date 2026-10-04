/**
 * 動的な値を code context (インラインのコード / フェンス付きコードブロック) に閉じ込める
 * (bdboard-4y8q.2、bdboard-4y8q.1 の再レビュー指摘 (1): source / catalogSlug の 1 行の中のリンク・@mention・
 * #123 / owner/repo#1 の相互参照・<img>)。
 *
 * なぜコードの中なら安全か: GitHub Flavored Markdown は、コードスパンとコードブロックの中身を文字どおりの
 * 文字列として扱う。Markdown のリンク記法・URL の自動リンク・`@user` のメンション (通知が飛ぶ)・`#123` や
 * `owner/repo#1` や SHA の相互参照・生の HTML (`<img>` を含む)・HTML コメント・見出しや引用の記号は、
 * いずれも解釈されない (表示用の文字になる)。だから動的な値は、この 2 つの関数を通してだけ出力へ入れる。
 * コードの外に出るのは、組み立てる側 (issue-public-build.ts) が持つ固定の文言だけ。
 *
 * フェンスの長さ: 中身の中のバッククォートの連なりのうち最長のものより 1 長くする。中身がコードを閉じる手段を持たない
 * (閉じる区切りは、開く区切りと同じ長さ以上の連なりを要する。中身にはそれより長い連なりが無い)。
 * 渡される文字列は、行の整形 (issue-public-text.ts) と置換 (issue-public-redact.ts) を終えたもの。
 */
import type { RedactedText, TextMark } from './issue-public-redact.js';

/** 区切りを付けた文字列と、その中の印 (位置は text 先頭からの UTF-16 オフセット。区切りの長さだけずらしてある)。 */
export interface MarkdownPiece {
  readonly text: string;
  readonly marks: readonly TextMark[];
}

/** 最長のバッククォートの連なりの長さ。 */
function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    current = character === '`' ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function shiftMarks(marks: readonly TextMark[], offset: number): TextMark[] {
  return marks.map((mark) => ({ ...mark, start: mark.start + offset, end: mark.end + offset }));
}

/**
 * インラインのコードスパン (1 行)。区切りは中身の最長の連なりより 1 長いバッククォート。中身がバッククォートで
 * 始まる・終わるときは、CommonMark の規則 (両端の空白 1 つを取り除く) を使い、内側に空白を 1 つずつ足して区切りと
 * 中身の連なりが繋がらないようにする。中身の前後は整形で trim 済みなので、元から前後に空白がある中身は来ない。
 */
export function codeSpan(redacted: RedactedText): MarkdownPiece {
  const delimiter = '`'.repeat(longestBacktickRun(redacted.text) + 1);
  const padded = redacted.text.startsWith('`') || redacted.text.endsWith('`');
  const prefix = delimiter + (padded ? ' ' : '');
  const suffix = (padded ? ' ' : '') + delimiter;
  return { text: prefix + redacted.text + suffix, marks: shiftMarks(redacted.marks, prefix.length) };
}

/**
 * 複数行のコードブロック。フェンスは max(3, 中身の最長の連なり + 1) 個のバッククォートで、情報文字列は固定の `text`。
 * 閉じるフェンスの前に改行を 1 つ置く (中身の最後の行がフェンスと同じ行にならない)。
 */
export function codeBlock(redacted: RedactedText): MarkdownPiece {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(redacted.text) + 1));
  const prefix = `${fence}text\n`;
  return {
    text: `${prefix}${redacted.text}\n${fence}`,
    marks: shiftMarks(redacted.marks, prefix.length),
  };
}
