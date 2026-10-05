/**
 * 届いた issue の機械の検査のうち「リンクの数」(bdboard-4y8q.9.1、docs/ISSUE-REPORTING.md 8節)。
 * 数と内訳だけを返す (どの URL が危ないかは見ない)。
 *
 * 数える 4 種類 (優先順に、前の種類の範囲の中で始まる後ろの種類は数えない = 同じ URL を二重に数えない):
 *   1. Markdown のリンク `[text](dest)` と画像 `![alt](dest)` (画像は先頭の `!` を除いて同じ形)
 *   2. 参照定義 `[label]: dest` (行頭から 3 字下げまで。`[^1]:` の脚注は除く)。`[text][label]` の使う側は数えない。
 *      宛先が `<https://…>` の形でも、定義の 1 件に数える (autolink にはしない)
 *   3. autolink `<scheme:…>` (メールの `<a@b>` は URL ではないので数えない)
 *   4. 生の URL `http://…` / `https://…` と `www.…` (GitHub は `www.` で始まるものもリンクにする。GFM の拡張 www autolink)
 * 同じ種類の中では、入れ子 (`[![img](a)](b)`) も別々に数える。
 *
 * コードブロックの中は読まない (コードの中の `[x](y)` も数える。数えすぎは安全な側のずれ)。
 * どの走査も線形: 正規表現は文字クラスの繰り返しだけ (開きの括弧ごとに先を探し直す形は使わない)、`)` と改行の探索は
 * 前に進むだけのキャッシュで、同じ範囲を二度読まない。
 *
 * 時間だけでなく確保も小さく保つ (bdboard-clym)。見つけた範囲を 1 件ずつオブジェクトにすると、リンクが 10 万件ある本文では
 * 生きたままのオブジェクトが数 MB になって GC が生き残りをコピーし、種類ごとに「配列の複製・並べ替え・まとめ直し」で
 * 大きな配列を何本も作る。小さい入力ではこの GC や大きな確保が入らないので、大きい入力の時間だけが線形より速く伸びる
 * (「大 / 小」が 10 を超え、Windows の CI で 25 を超えた)。そこで範囲は `RangeList` (開始と終了を並べた `Int32Array`) に
 * 入れ、並べ替えもまとめ直しもしない。
 */

export interface LinkCheck {
  /** 内訳の合計。 */
  readonly total: number;
  readonly markdownLinks: number;
  readonly autolinks: number;
  readonly referenceDefinitions: number;
  readonly rawUrls: number;
}

/**
 * 範囲 `[start, end)` の並び。範囲ごとにオブジェクトを作らず、開始と終了を交互に 1 本の `Int32Array` (`[s0, e0, s1, e1, …]`) に
 * 入れる (足りなくなったら 2 倍にする)。文字列の長さは V8 では 2^29 未満なので、位置は `Int32Array` に収まる。
 * `covers` は、並びが重ならず開始の昇順であることを前提にする (どの種類もそうなるように作る)。
 * 配列でなく `Int32Array` にしたのは、`number[]` の `push` でも、大きくなるたびの作り直しの確保が測れる差になるため。
 */
class RangeList {
  // 初期の 16 個 (64 バイト) は V8 が GC のヒープ内に置くので、範囲の無い (多くの) 本文では外部メモリを確保しない。
  private buffer = new Int32Array(16);
  /** 入っている数の個数 (範囲の数の 2 倍)。 */
  private used = 0;

  /** 範囲の数。 */
  get count(): number {
    return this.used / 2;
  }

  /** 末尾の範囲の終了。空なら -1。 */
  lastEnd(): number {
    return this.used === 0 ? -1 : (this.buffer[this.used - 1] ?? -1);
  }

  /** 末尾の範囲を取り除いて、その開始を返す (空なら呼ばない)。 */
  popStart(): number {
    this.used -= 2;
    return this.buffer[this.used] ?? 0;
  }

  push(start: number, end: number): void {
    if (this.used + 2 > this.buffer.length) {
      const grown = new Int32Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.used] = start;
    this.buffer[this.used + 1] = end;
    this.used += 2;
  }

  /** 並びの中に位置があるか。二分探索。 */
  covers(position: number): boolean {
    let low = 0;
    let high = this.used / 2 - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const start = this.buffer[2 * mid];
      const end = this.buffer[2 * mid + 1];
      if (start === undefined || end === undefined) return false;
      if (position < start) high = mid - 1;
      else if (position >= end) low = mid + 1;
      else return true;
    }
    return false;
  }
}

const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const NEWLINE = 0x0a;
const BACKTICK = 0x60;

/** スキームは 2〜32 文字 (CommonMark の autolink)。`[^\s<>]*` は次の空白・`<`・`>` で必ず止まる。 */
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/g;
/** ラベルは 1〜999 文字 (CommonMark)。宛先が行の中に無い (`[x]:` だけ) ものは定義ではない。 */
const REFERENCE_DEFINITION = /^ {0,3}\[(?!\^)[^\]\n]{1,999}\]:[ \t]*\S+/gm;
/**
 * 前が英数字でない `http(s)://` か `www.`。`\b` だと `_https://…_` (GitHub では斜体のリンク。GFM の拡張 autolink は `_` `*` `~` `(` の後でも
 * 始まる) を `_` が単語の文字なので取りこぼす。
 */
const RAW_URL = /(?<![A-Za-z0-9])(?:https?:\/\/|www\.)[^\s<>]+/gi;

/**
 * `[text](dest)` を 1 回の前向きの走査で見つける。`[` の位置を積み、`]` で 1 つ取り出し、直後が `(` なら
 * 同じ行の最初の `)` までを宛先とする。宛先は読み飛ばす (その中の `[` `]` では何も始めない)。
 * 宛先の終わりは「最初の `)`」: `Foo_(bar)` のように括弧を含む宛先は途中で終わるが、リンクの数は変わらない。
 *
 * 件数 (`count`) と、ほかの種類と重ねて見る範囲 (`covered`) を返す。範囲は 1 件ごとに数えず、重なるものを 1 つにまとめた
 * 並び (入れ子の `[![img](a)](b)` は外側の 1 つに含まれる)。文 (`[` から `]` まで) が改行かバッククォートをまたぐときは
 * `](宛先)` だけにする。`[` は Markdown の文脈を読まずに積むので、段落・見出し・コードスパンの向こうの `[` と組んだ
 * 偽のリンク 1 件が、間にある生の URL・参照定義・autolink を何件でも覆って消してしまう (GitHub ではどれも別のリンクとして
 * 描画される。4y8q.9.1 のレビュー)。縮めた結果のずれは偽のリンクの 1 件ぶんの数えすぎで、安全な側。
 *
 * まとめ方: 見つかる順は終了 (`)` の次) が昇順なので、並べ替えずに済む。1 件見つけると走査は宛先の `)` まで飛ぶので、
 * 次の `]` も、その宛先の `)` も必ずそれより後ろにある (宛先の中で走査を止める・戻す変更はこの前提を崩す)。
 * 新しい範囲の開始より後ろまで届いている末尾の範囲を取り除いて 1 つにし (償却で 1 回ずつ)、末尾に足す。
 */
function findInlineLinks(text: string): { readonly count: number; readonly covered: RangeList } {
  const covered = new RangeList();
  let count = 0;
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
  // 最後に見た改行かバッククォートの位置 (宛先の中は読み飛ばすが、宛先は改行を含まない)。
  let lastBreak = -1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === BACKSLASH) {
      index += 1;
      if (text.charCodeAt(index) === NEWLINE) lastBreak = index; // `\` + 改行は強制改行で、行はまたぐ
    } else if (code === NEWLINE || code === BACKTICK) {
      lastBreak = index;
    } else if (code === OPEN_BRACKET) {
      open.push(index);
    } else if (code === CLOSE_BRACKET) {
      const start = open.pop();
      if (start === undefined || text.charCodeAt(index + 1) !== OPEN_PAREN) continue;
      const end = stopAtOrAfter(index + 2);
      if (end >= text.length || text.charCodeAt(end) !== CLOSE_PAREN) continue;
      let rangeStart = lastBreak > start ? index : start;
      // 末尾の範囲が新しい範囲の開始より後ろまで届いているなら (重なるなら) 取り除いて、新しい範囲に含める。
      // 接するだけ (末尾の終了 === 新しい開始) ではまとめない。
      // 取り除く範囲の開始は常に新しい開始より後ろなので、`Math.min` は常に `rangeStart` を返す。前提が崩れたとき (終了が昇順でなくなったとき) のための防御。
      while (covered.lastEnd() > rangeStart) rangeStart = Math.min(rangeStart, covered.popStart());
      covered.push(rangeStart, end + 1);
      count += 1;
      index = end;
    }
  }
  return { count, covered };
}

/** どれかの並びの中に位置があるか。 */
function isCoveredByAny(lists: readonly RangeList[], position: number): boolean {
  for (const ranges of lists) {
    if (ranges.covers(position)) return true;
  }
  return false;
}

/**
 * 正規表現の一致のうち、すでに数えた範囲 (`covered` のどれか) の外で始まるものの範囲。`matchAll` は文字列の前から
 * 重ならない一致を順に返すので、返す並びは開始の昇順で重ならない (そのまま `covers` に使える)。
 */
function matchesOutside(text: string, pattern: RegExp, covered: readonly RangeList[]): RangeList {
  const kept = new RangeList();
  for (const match of text.matchAll(pattern)) {
    if (isCoveredByAny(covered, match.index)) continue;
    kept.push(match.index, match.index + match[0].length);
  }
  return kept;
}

export function countLinks(text: string): LinkCheck {
  const inline = findInlineLinks(text);
  // 後ろの種類は、前の種類の範囲の中で始まるものを数えない。種類ごとの並びを別々に見る (1 本にまとめ直さない)。
  const definitions = matchesOutside(text, REFERENCE_DEFINITION, [inline.covered]);
  const autolinks = matchesOutside(text, AUTOLINK, [inline.covered, definitions]);
  const rawUrls = matchesOutside(text, RAW_URL, [inline.covered, definitions, autolinks]);
  return {
    total: inline.count + autolinks.count + definitions.count + rawUrls.count,
    markdownLinks: inline.count,
    autolinks: autolinks.count,
    referenceDefinitions: definitions.count,
    rawUrls: rawUrls.count,
  };
}
