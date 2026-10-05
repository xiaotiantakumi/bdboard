/**
 * 届いた issue の機械の検査のうち「リンクの数」(bdboard-4y8q.9.1、docs/ISSUE-REPORTING.md 8節)。
 * 数と内訳だけを返す (どの URL が危ないかは見ない)。
 *
 * 数える 4 種類 (優先順に、前の種類の範囲の中で始まる後ろの種類は数えない = 同じ URL を二重に数えない):
 *   1. Markdown のリンク `[text](dest)` と画像 `![alt](dest)` (画像は先頭の `!` を除いて同じ形)
 *   2. 参照定義 `[label]: dest` (行頭から 3 字下げまで。`[^1]:` の脚注は除く)。`[text][label]` の使う側は数えない。
 *      宛先が `<https://…>` の形でも、定義の 1 件に数える (autolink にはしない)
 *   3. autolink `<scheme:…>` (メールの `<a@b>` は URL ではないので数えない)
 *   4. 生の URL `http://…` / `https://…` (`www.…` のようにスキームが無いものは数えない)
 * 同じ種類の中では、入れ子 (`[![img](a)](b)`) も別々に数える。
 *
 * コードブロックの中は読まない (コードの中の `[x](y)` も数える。数えすぎは安全な側のずれ)。
 * どの走査も線形: 正規表現は文字クラスの繰り返しだけ (開きの括弧ごとに先を探し直す形は使わない)、`)` と改行の探索は
 * 前に進むだけのキャッシュで、同じ範囲を二度読まない。
 */

export interface LinkCheck {
  /** 内訳の合計。 */
  readonly total: number;
  readonly markdownLinks: number;
  readonly autolinks: number;
  readonly referenceDefinitions: number;
  readonly rawUrls: number;
}

interface Range {
  readonly start: number;
  readonly end: number;
}

const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const NEWLINE = 0x0a;

/** スキームは 2〜32 文字 (CommonMark の autolink)。`[^\s<>]*` は次の空白・`<`・`>` で必ず止まる。 */
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/g;
/** ラベルは 1〜999 文字 (CommonMark)。宛先が行の中に無い (`[x]:` だけ) ものは定義ではない。 */
const REFERENCE_DEFINITION = /^ {0,3}\[(?!\^)[^\]\n]{1,999}\]:[ \t]*\S+/gm;
const RAW_URL = /\bhttps?:\/\/[^\s<>]+/gi;

/**
 * `[text](dest)` を 1 回の前向きの走査で見つける。`[` の位置を積み、`]` で 1 つ取り出し、直後が `(` なら
 * 同じ行の最初の `)` までを宛先とする。宛先は読み飛ばす (その中の `[` `]` では何も始めない)。
 * 宛先の終わりは「最初の `)`」: `Foo_(bar)` のように括弧を含む宛先は途中で終わるが、リンクの数は変わらない。
 */
function findInlineLinks(text: string): Range[] {
  const found: Range[] = [];
  const open: number[] = [];
  // 最初の `)` または改行の位置のキャッシュ。問い合わせの位置は単調に増えるので、キャッシュより先ならそのまま使える。
  let stop = -1;
  const stopAtOrAfter = (from: number): number => {
    if (stop >= from) return stop;
    let index = from;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === CLOSE_PAREN || code === NEWLINE) break;
      index += 1;
    }
    stop = index;
    return index;
  };
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === BACKSLASH) {
      index += 1;
    } else if (code === OPEN_BRACKET) {
      open.push(index);
    } else if (code === CLOSE_BRACKET) {
      const start = open.pop();
      if (start === undefined || text.charCodeAt(index + 1) !== OPEN_PAREN) continue;
      const end = stopAtOrAfter(index + 2);
      if (end >= text.length || text.charCodeAt(end) !== CLOSE_PAREN) continue;
      found.push({ start, end: end + 1 });
      index = end;
    }
  }
  return found;
}

/** 重なる範囲をまとめて、開始の昇順に並べる。 */
function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start < last.end) {
      if (range.end > last.end) merged[merged.length - 1] = { start: last.start, end: range.end };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** まとめた範囲 (昇順・重ならない) の中に位置があるか。二分探索。 */
function isCovered(merged: readonly Range[], position: number): boolean {
  let low = 0;
  let high = merged.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = merged[mid];
    if (range === undefined) return false;
    if (position < range.start) high = mid - 1;
    else if (position >= range.end) low = mid + 1;
    else return true;
  }
  return false;
}

/** 正規表現の一致のうち、すでに数えた範囲の外で始まるものの範囲。 */
function matchesOutside(text: string, pattern: RegExp, covered: readonly Range[]): Range[] {
  const kept: Range[] = [];
  for (const match of text.matchAll(pattern)) {
    if (isCovered(covered, match.index)) continue;
    kept.push({ start: match.index, end: match.index + match[0].length });
  }
  return kept;
}

export function countLinks(text: string): LinkCheck {
  const inline = findInlineLinks(text);
  const definitions = matchesOutside(text, REFERENCE_DEFINITION, mergeRanges(inline));
  const autolinks = matchesOutside(text, AUTOLINK, mergeRanges([...inline, ...definitions]));
  const rawUrls = matchesOutside(text, RAW_URL, mergeRanges([...inline, ...definitions, ...autolinks]));
  return {
    total: inline.length + autolinks.length + definitions.length + rawUrls.length,
    markdownLinks: inline.length,
    autolinks: autolinks.length,
    referenceDefinitions: definitions.length,
    rawUrls: rawUrls.length,
  };
}
