/**
 * 公開本文に入れる動的な文字列の「下ごしらえ」(bdboard-4y8q.2、docs/ISSUE-REPORTING.md 5節)。
 * 置き換えより前に、どの文字列にも最初に 1 回だけかける (孤立サロゲートの除去 → 行・不可視文字の整形)。
 * 秘密の形は見ない (それは issue-public-secrets.ts / issue-public-keys.ts)。ここの正規表現はどれも線形で、
 * 空白や改行が 100k 文字続く入力でも 2 乗に膨らまない (`\s+$` や配列の shift の繰り返しは使わない)。
 */
import { stripNonLineText } from './issue-draft-identifier.js';

/**
 * 孤立したサロゲート (対になっていない上位・下位) を見つける。`u` フラグを付けない = コード単位で読む。
 * 付けると孤立サロゲートが 1 文字のコードポイントとして扱われ、前後の先読み・後読みの意味が変わる。
 * 正しい対 (上位の直後に下位) は残る。上位が 2 つ続く "\uD83D😀" は 1 つ目だけが孤立。
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const INLINE_BREAK = /\r\n|[\r\n\t\u2028\u2029\u0085\v\f]/g;
const BLOCK_BREAK = /\r\n|[\r\u2028\u2029\u0085\v\f]/g;

/** 孤立サロゲートを取り除く。公開本文に出る前に必ず通す (JSON や UTF-8 にしたとき壊れた文字になる)。 */
export function removeLoneSurrogates(value: string): string {
  return value.replace(LONE_SURROGATE, '');
}

/**
 * 1 行の値 (名前・版・時刻) の整形: 孤立サロゲートを除き、改行・タブ・行区切り・VT・FF を空白 1 つにし、
 * 1 行の検査で弾く文字 (stripNonLineText) を取り除き、空白の連なりを 1 つにして前後を落とす。
 */
export function normalizeInline(value: string): string {
  return stripNonLineText(removeLoneSurrogates(value).replace(INLINE_BREAK, ' '))
    .replace(/ +/g, ' ')
    .trim();
}

/**
 * 複数行の値 (症状・原因・エラー文など) の整形: 孤立サロゲートを除き、改行の種類を LF にそろえ、タブは空白 2 つ、
 * 行ごとに stripNonLineText をかけ、各行の末尾の空白を落とし、先頭と末尾の空行を落とす。行頭の字下げは残す。
 * 末尾の空白は `trimEnd` (線形) で落とす: `/\s+$/` は空白が長く続くと 2 乗になる。空行の除去も添字を進めるだけで、
 * 先頭からの `shift()` を繰り返さない (10 万行の空行で 2 乗になる)。
 */
export function normalizeBlock(value: string): string {
  const lines = removeLoneSurrogates(value)
    .replace(BLOCK_BREAK, '\n')
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => stripNonLineText(line).trimEnd());
  let first = 0;
  while (first < lines.length && lines[first] === '') first += 1;
  let last = lines.length;
  while (last > first && lines[last - 1] === '') last -= 1;
  return lines.slice(first, last).join('\n');
}

/** コードポイント数 (サロゲートの対を 1 と数える)。 */
export function codePointLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    const isHigh = unit >= 0xd800 && unit <= 0xdbff;
    const next = value.charCodeAt(index + 1);
    if (isHigh && next >= 0xdc00 && next <= 0xdfff) index += 1;
    length += 1;
  }
  return length;
}

/** 先頭 count コードポイントを含めた直後の UTF-16 オフセット。対の途中では切らない。 */
export function codeUnitIndexAfterCodePoints(value: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  let offset = 0;
  for (const character of value) {
    if (seen >= count) break;
    offset += character.length;
    seen += 1;
  }
  return offset;
}

/** 末尾 count コードポイントを残すとき、その先頭になる UTF-16 オフセット。対の途中では切らない。 */
export function codeUnitIndexBeforeTailCodePoints(value: string, count: number): number {
  if (count <= 0) return value.length;
  let offset = value.length;
  let seen = 0;
  while (offset > 0 && seen < count) {
    offset -= 1;
    const unit = value.charCodeAt(offset);
    if (unit >= 0xdc00 && unit <= 0xdfff && offset > 0) {
      const previous = value.charCodeAt(offset - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) offset -= 1;
    }
    seen += 1;
  }
  return offset;
}

/** 先頭 maximum コードポイントだけ残す。 */
export function cutCodePointsHead(value: string, maximum: number): string {
  return value.slice(0, codeUnitIndexAfterCodePoints(value, maximum));
}
