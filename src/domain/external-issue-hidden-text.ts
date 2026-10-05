/**
 * 届いた issue (ほかの人が出した公開 issue) の機械の検査のうち、「見えない・見えにくい文字列」を数える 3 つ
 * (bdboard-4y8q.9.1、docs/ISSUE-REPORTING.md 8節)。見えない文字 / HTML コメント / 長い符号化文字列。
 *
 * ここは数と位置だけを返す。「安全」「危険」の判断はしない (判断は 4y8q.10 の 2 体のエージェントと人間)。
 * どの検査も 1 回の走査 (indexOf は前に進むだけ) で終わり、長い入力でも 2 乗に膨らまない。正規表現は使わない
 * (使うと、閉じない `<!--` や長い連なりでバックトラックが起きうる)。
 *
 * 位置と長さは、渡された文字列への UTF-16 のコード単位のオフセット (`text.slice(start, end)` にそのまま使える)。
 * 検査はコードブロックや Markdown の文脈を読まない: コードブロックの中の `<!-- -->` も数える (数えすぎは、
 * 隠れているものを見落とすより安全な側のずれ)。
 */

/** 位置を残す件数の上限。種類ごと (見えない文字は文字の種類ごと) に先頭からこの件数まで。件数は上限を超えても数え続ける。 */
export const MACHINE_CHECK_POSITION_LIMIT = 50;

/** 長い符号化文字列とみなす連なりの最小の長さ。 */
export const LONG_ENCODED_MIN_LENGTH = 200;

export type InvisibleCharGroup = 'zero-width' | 'bidi-control' | 'tag';

interface InvisibleCharSpec {
  /** 1 文字の項目はそのコードポイント。範囲の項目は先頭。 */
  readonly code: number;
  /** 範囲の項目の末尾 (含む)。範囲は 1 つの種類として数える (128 個のタグ文字を 128 種類に分けない)。 */
  readonly last?: number;
  readonly name: string;
  readonly group: InvisibleCharGroup;
}

/**
 * 検査する文字の表 (設計 8節 + 4y8q.9.1 のレビュー)。幅ゼロの文字 5 つ、向きを変える制御文字 (Unicode の Bidi_Control
 * 12 文字。設計の表の 9 つ = Trojan Source 系に、同じ性質の ALM・LRM・RLM の 3 つを足した)、タグ文字 (U+E0000–E007F)。
 * タグ文字は画面に何も出ないのに ASCII を 1 文字ずつ写せる (ASCII smuggling)。人には見えず、判定のエージェント
 * (4y8q.10) のモデルには読めることがあるので数える。旗の絵文字 (イングランドなど 3 つ) もタグ文字を使うが、まれ。
 */
const INVISIBLE_CHARS: readonly InvisibleCharSpec[] = [
  { code: 0x200b, name: 'ZERO WIDTH SPACE', group: 'zero-width' },
  { code: 0x200c, name: 'ZERO WIDTH NON-JOINER', group: 'zero-width' },
  { code: 0x200d, name: 'ZERO WIDTH JOINER', group: 'zero-width' },
  { code: 0x2060, name: 'WORD JOINER', group: 'zero-width' },
  { code: 0xfeff, name: 'ZERO WIDTH NO-BREAK SPACE', group: 'zero-width' },
  { code: 0x202a, name: 'LEFT-TO-RIGHT EMBEDDING', group: 'bidi-control' },
  { code: 0x202b, name: 'RIGHT-TO-LEFT EMBEDDING', group: 'bidi-control' },
  { code: 0x202c, name: 'POP DIRECTIONAL FORMATTING', group: 'bidi-control' },
  { code: 0x202d, name: 'LEFT-TO-RIGHT OVERRIDE', group: 'bidi-control' },
  { code: 0x202e, name: 'RIGHT-TO-LEFT OVERRIDE', group: 'bidi-control' },
  { code: 0x2066, name: 'LEFT-TO-RIGHT ISOLATE', group: 'bidi-control' },
  { code: 0x2067, name: 'RIGHT-TO-LEFT ISOLATE', group: 'bidi-control' },
  { code: 0x2068, name: 'FIRST STRONG ISOLATE', group: 'bidi-control' },
  { code: 0x2069, name: 'POP DIRECTIONAL ISOLATE', group: 'bidi-control' },
  { code: 0x061c, name: 'ARABIC LETTER MARK', group: 'bidi-control' },
  { code: 0x200e, name: 'LEFT-TO-RIGHT MARK', group: 'bidi-control' },
  { code: 0x200f, name: 'RIGHT-TO-LEFT MARK', group: 'bidi-control' },
  { code: 0xe0000, last: 0xe007f, name: 'TAG CHARACTER', group: 'tag' },
];

/** 表の文字のうち最小のコードポイント。これ未満のコード単位 (ASCII の全部など) は表を引かずに抜ける。 */
const SMALLEST_LISTED = Math.min(...INVISIBLE_CHARS.map((spec) => spec.code));
const SINGLE_BY_CODE: ReadonlyMap<number, InvisibleCharSpec> = new Map(
  INVISIBLE_CHARS.filter((spec) => spec.last === undefined).map((spec) => [spec.code, spec]),
);
const RANGES: readonly InvisibleCharSpec[] = INVISIBLE_CHARS.filter((spec) => spec.last !== undefined);

function specOf(code: number): InvisibleCharSpec | undefined {
  return SINGLE_BY_CODE.get(code) ?? RANGES.find((spec) => code >= spec.code && code <= (spec.last ?? spec.code));
}

function formatCodePoint(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 見えない文字 1 種類ぶんの結果。`positions` は先頭から `MACHINE_CHECK_POSITION_LIMIT` 件まで (`count` が多ければ打ち切っている)。 */
export interface InvisibleCharKind {
  /** `U+200B` の形。範囲の種類 (タグ文字) は `U+E0000..U+E007F`。 */
  readonly codePoint: string;
  readonly name: string;
  readonly group: InvisibleCharGroup;
  readonly count: number;
  readonly positions: readonly number[];
}

export interface InvisibleCharCheck {
  /** 全種類の合計。 */
  readonly total: number;
  /** 1 つ以上あった種類だけ。コードポイントの昇順。 */
  readonly kinds: readonly InvisibleCharKind[];
}

export function findInvisibleChars(text: string): InvisibleCharCheck {
  const found = new Map<number, { count: number; positions: number[] }>();
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < SMALLEST_LISTED) continue;
    // コードポイントで読む (タグ文字はサロゲートの対)。位置は対の上位のコード単位のオフセット。孤立サロゲートは表に無い。
    const start = index;
    const code = text.codePointAt(index) ?? 0;
    if (code > 0xffff) index += 1;
    const spec = specOf(code);
    if (spec === undefined) continue;
    total += 1;
    const entry = found.get(spec.code) ?? { count: 0, positions: [] };
    entry.count += 1;
    if (entry.positions.length < MACHINE_CHECK_POSITION_LIMIT) entry.positions.push(start);
    found.set(spec.code, entry);
  }
  const kinds = INVISIBLE_CHARS.filter((spec) => found.has(spec.code))
    .sort((a, b) => a.code - b.code)
    .map((spec): InvisibleCharKind => {
      const entry = found.get(spec.code);
      return {
        codePoint: spec.last === undefined ? formatCodePoint(spec.code) : `${formatCodePoint(spec.code)}..${formatCodePoint(spec.last)}`,
        name: spec.name,
        group: spec.group,
        count: entry?.count ?? 0,
        positions: entry?.positions ?? [],
      };
    });
  return { total, kinds };
}

/** HTML コメント 1 件。`end` は含まない (`<!--` から `-->` の末尾まで。閉じていなければ文字列の末尾まで)。 */
export interface HtmlCommentSpan {
  readonly start: number;
  readonly end: number;
  readonly length: number;
  readonly closed: boolean;
}

export interface HtmlCommentCheck {
  /** 閉じていない `<!--` も 1 件に数える (最後の 1 件だけ。以降の文字列は全部そのコメントの中)。 */
  readonly count: number;
  /** 閉じていない `<!--` があるか。 */
  readonly unclosed: boolean;
  /** 全件の長さの合計。`<!--` と `-->` の分も含む (隠れている文字数)。 */
  readonly totalChars: number;
  /** 先頭から `MACHINE_CHECK_POSITION_LIMIT` 件まで。 */
  readonly spans: readonly HtmlCommentSpan[];
}

/**
 * `-->` は開きの `<!--` の直後から探す (`<!-->` は、自分の末尾の `-->` では閉じない)。CommonMark の新しい版は `<!-->` を
 * 空のコメントとみなすが、古い版 (GitHub の cmark-gfm 系) は違い、描画の側で分かれる。長い方に数えるほうが、隠れているものを
 * 見落とさない。
 */
export function findHtmlComments(text: string): HtmlCommentCheck {
  const spans: HtmlCommentSpan[] = [];
  let count = 0;
  let totalChars = 0;
  let unclosed = false;
  let from = 0;
  for (;;) {
    const start = text.indexOf('<!--', from);
    if (start < 0) break;
    const close = text.indexOf('-->', start + 4);
    const closed = close >= 0;
    const end = closed ? close + 3 : text.length;
    count += 1;
    totalChars += end - start;
    if (spans.length < MACHINE_CHECK_POSITION_LIMIT) spans.push({ start, end, length: end - start, closed });
    if (!closed) {
      unclosed = true;
      break;
    }
    from = end;
  }
  return { count, unclosed, totalChars, spans };
}

export interface LongEncodedSpan {
  readonly start: number;
  readonly length: number;
}

export interface LongEncodedCheck {
  readonly count: number;
  /** 見つかった連なりのうち最長の長さ。無ければ 0。 */
  readonly longest: number;
  /** 先頭から `MACHINE_CHECK_POSITION_LIMIT` 件まで。 */
  readonly spans: readonly LongEncodedSpan[];
}

/** base64 / base64url らしい文字集合 [A-Za-z0-9+/=_-]。 */
function isEncodedChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x3d || // =
    code === 0x5f || // _
    code === 0x2d // -
  );
}

export function findLongEncodedStrings(text: string, minLength: number = LONG_ENCODED_MIN_LENGTH): LongEncodedCheck {
  const spans: LongEncodedSpan[] = [];
  let count = 0;
  let longest = 0;
  let runStart = -1;
  // index === text.length で末尾の連なりを閉じる (その位置は文字集合の外として扱う)。
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && isEncodedChar(text.charCodeAt(index))) {
      if (runStart < 0) runStart = index;
      continue;
    }
    if (runStart < 0) continue;
    const length = index - runStart;
    runStart = -1;
    if (length < minLength) continue;
    count += 1;
    longest = Math.max(longest, length);
    if (spans.length < MACHINE_CHECK_POSITION_LIMIT) spans.push({ start: index - length, length });
  }
  return { count, longest, spans };
}
