/**
 * 手元の鍵 (プロジェクトの根・LONG の固有名詞) を、大文字小文字を区別せずに本文から探す (bdboard-uudb、docs/ISSUE-REPORTING.md 5節)。
 *
 * 以前は鍵の変種ごとに `/…/giu` のリテラルの正規表現を作っていた。V8 は i フラグの正規表現を、文字ごとの大文字小文字の閉包つきで
 * コンパイルする。長い鍵 (CJK・濁点・/ を混ぜた 1024 コードポイントの根 200 件 → 変種 2,800 本、1 本 6,000 文字前後) では 1 本数 ms かかり、
 * コンパイル済みのコードがキャッシュから追い出されるので、欄ごと・置き換えの回ごとにコンパイルし直す。プロファイルでは時間のほぼ全部が
 * これで (本文の走査そのものは数 ms)、1 回の組み立てが 117〜233 秒かかった。
 *
 * ここでは、正規表現エンジン自身に「どの文字どうしを同じとみなすか」を 1 文字ずつ尋ねて表を作り、本文と鍵の両方を表の代表の文字に
 * たたんでから、ふつうの indexOf で探す。表は 1 プロセスで 1 回だけ作る (0.1〜0.2 秒)。本文のたたみは BMP を型付き配列で引き、同じ本文は 1 回だけたたむ。
 * 欄の端の断片検査 (issue-public-fragments.ts) も、同じ代表にたたむ。
 *
 * 以前の `/…/giu` と同じ一致になる理由 (u フラグの i: 2 つの文字は Canonicalize = 単純な大文字小文字のたたみが等しいとき一致する):
 *   - リテラルの各文字は、本文の 1 コードポイントにだけ一致する。鍵が位置 p で一致する ⇔ 各コードポイントが同じ同値類にある。
 *   - 表: 大文字小文字で変わりうる文字 (Changes_When_Casefolded か Changes_When_Casemapped。約 3,000 文字) を並べた文字列を、
 *     各文字の `/x/giu` で探して、同値類をエンジンから直接得る。代表は類の中で最小のコードポイント。
 *   - 表の外の文字は自分だけの類 (たたまない): 単純なたたみで別の文字になる文字は Changes_When_Casefolded か Changes_When_Casemapped
 *     なので表に入る (U+1FBE は NFD が ι なので Changes_When_Casefolded ではなく、Changes_When_Casemapped で入る)。
 *     表を作るときに、(1) 類が対称で推移的 (どの要素から引いても同じ類) (2) 類の中で UTF-16 の長さが混ざらない (たたんでも位置が
 *     ずれない) (3) 表の文字を集めた `/[…]/giu` が表の外の文字に一致しない、を確かめる。どれかが成り立たないエンジンでは表を使わず、
 *     以前と同じ `/…/giu` で探す (遅いが同じ結果)。
 *   - 鍵のすべての出現を探し、自分と重なる出現は 1 つの範囲に併合する (接するだけなら別範囲。周期的でない鍵では以前の `/…/giu` と同じ一致。
 *     bdboard-0hj9 まで: 一致の終わりから次を探していたので、重なる 2 つ目を見落とした)。探し方 (indexOf と KMP) は issue-public-literal-search.ts。
 *     根は、直後の 1 文字が `[\p{L}\p{N}_-]` (i つき。以前の先読みと同じもの) でない出現だけを一致にする。
 *   - 鍵が n コードポイントなら一致は n コード単位以上なので、それより短い本文では探さない (正規表現でも同じく一致しない)。
 */

/** 大文字小文字で変わりうる文字。これ以外の文字は、i フラグでも自分にしか一致しない (上の (3) で確かめる)。 */
const CASE_VARIABLE = /[\p{Changes_When_Casefolded}\p{Changes_When_Casemapped}]/u;

/** 標準の escapeRegExp。`-` は escape しない (`u` フラグでは範囲外の `\-` は構文エラー)。 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hexEscape(codePoint: number): string {
  return `\\u{${codePoint.toString(16)}}`;
}

/**
 * 表。canonical は表に入る文字のコードポイント → 代表のコードポイント。bmp は BMP のコード単位 → 代表 (表の外は自分)。
 * (2) により BMP の文字の代表は BMP、astral の文字の代表は astral なので、BMP は bmp を引くだけでよく、canonical を引くのは
 * サロゲート対の文字だけ。使えないエンジンでは null。
 */
export interface CaseTable {
  readonly canonical: ReadonlyMap<number, number>;
  readonly bmp: Uint16Array;
}

let table: CaseTable | null | undefined;

let variableCodePoints: readonly number[] | undefined;
let joinedVariableCharacters: string | undefined;

function caseVariableCharacters(): { readonly codePoints: readonly number[]; readonly joined: string } {
  if (variableCodePoints === undefined || joinedVariableCharacters === undefined) {
    const points: number[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint === 0xd800) codePoint = 0xe000;
      if (CASE_VARIABLE.test(String.fromCodePoint(codePoint))) points.push(codePoint);
    }
    variableCodePoints = points;
    joinedVariableCharacters = points.map((codePoint) => String.fromCodePoint(codePoint)).join('');
  }
  return { codePoints: variableCodePoints, joined: joinedVariableCharacters };
}

const engineRepresentatives = new Map<number, number>();

/**
 * 表を使わず、正規表現エンジンに尋ねて、1 コードポイントを /…/giu で一致する文字の最小のコードポイントへたたむ (表が使えないときの退避)。
 * エンジンの関係が同値関係で、大文字小文字で変わりうる文字の中で閉じているとき (表を作るときの (1)(3) が成り立つとき) は、本体の
 * `/…/giu` と同じ同値類の代表になる。(1)(3) が崩れたエンジンでは食い違いうる。引数は 1 コードポイントだけ。
 */
export function engineFoldCodePoint(point: string): string {
  // 大文字小文字で変わらない文字は自分だけの類 (表の外の文字と同じ前提)。尋ねるのは約 3,000 文字だけで、キャッシュもその数に収まる。
  if (!CASE_VARIABLE.test(point)) return point;
  const codePoint = point.codePointAt(0);
  if (codePoint === undefined) return point;
  const cached = engineRepresentatives.get(codePoint);
  if (cached !== undefined) return cached === codePoint ? point : String.fromCodePoint(cached);
  const { joined } = caseVariableCharacters();
  const members = Array.from(joined.matchAll(new RegExp(hexEscape(codePoint), 'giu')), (match) => match[0].codePointAt(0) ?? codePoint);
  const representative = Math.min(codePoint, ...members);
  engineRepresentatives.set(codePoint, representative);
  return representative === codePoint ? point : String.fromCodePoint(representative);
}

/**
 * 表で 1 コードポイントをたたむ。表が null (使えないエンジン) のときは engineFoldCodePoint に退避する。foldCodePoint の本体で、
 * 退避の配線をテストできるよう、表を引数で渡せるように分けてある。引数は 1 コードポイントだけ (複数を渡すと先頭の 1 つだけを見て、後ろを落とす)。
 */
export function foldCodePointWith(point: string, caseTableValue: CaseTable | null): string {
  const codePoint = point.codePointAt(0);
  if (codePoint === undefined) return point;
  if (caseTableValue === null) return engineFoldCodePoint(point);
  const target = codePoint <= 0xffff ? caseTableValue.bmp[codePoint] ?? codePoint : caseTableValue.canonical.get(codePoint) ?? codePoint;
  return target === codePoint ? point : String.fromCodePoint(target);
}

/** 1 コードポイントを、本体検索と同じ同値類の代表へたたむ (表が使えるときは表、使えないときはエンジンに尋ねる)。引数は 1 コードポイントだけ。 */
export function foldCodePoint(point: string): string {
  return foldCodePointWith(point, caseTable());
}

function buildTable(): CaseTable | null {
  const { codePoints: variable, joined } = caseVariableCharacters();
  const classes = new Map<number, readonly number[]>();
  for (const codePoint of variable) {
    const members = Array.from(joined.matchAll(new RegExp(hexEscape(codePoint), 'giu')), (match) => match[0].codePointAt(0) ?? -1);
    const width = codePoint > 0xffff ? 2 : 1;
    // (2) 類の中で長さが混ざるなら、たたむと位置がずれる。
    if (!members.includes(codePoint) || members.some((member) => (member > 0xffff ? 2 : 1) !== width)) return null;
    classes.set(codePoint, members);
  }
  const canonical = new Map<number, number>();
  for (const [codePoint, members] of classes) {
    // (1) 対称で推移的: 類のどの要素から引いても同じ類。
    const key = members.join(',');
    if (members.some((member) => classes.get(member)?.join(',') !== key)) return null;
    canonical.set(codePoint, Math.min(...members));
  }
  // (3) 表の外の文字は、表のどの文字とも同じとみなされない。表の文字を集めた i つきの文字クラスで全コードポイントを走査する。
  const anyVariable = new RegExp(`[${variable.map(hexEscape).join('')}]`, 'giu');
  const chunk: string[] = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint === 0xd800) codePoint = 0xe000;
    if (!canonical.has(codePoint)) chunk.push(String.fromCodePoint(codePoint));
  }
  if (anyVariable.test(chunk.join(''))) return null;
  const bmp = new Uint16Array(0x10000);
  for (let unit = 0; unit < 0x10000; unit += 1) bmp[unit] = unit;
  for (const [codePoint, target] of canonical) {
    // (2) で類の幅が揃い、代表は類の最小値なので、BMP の文字の代表は BMP。
    if (codePoint <= 0xffff) bmp[codePoint] = target;
  }
  return { canonical, bmp };
}

function caseTable(): CaseTable | null {
  if (table === undefined) table = buildTable();
  return table;
}

/** 表が使えるか (使えないエンジンでは、以前と同じ正規表現で探す)。テストが確かめる。 */
export function caseFoldingTableUsable(): boolean {
  return caseTable() !== null;
}

const DECODE_CHUNK = 8192;

/**
 * 文字列の各コードポイントを、i フラグで同じとみなされる文字の代表にたたむ。UTF-16 の長さと位置は変わらない。
 * コードポイントの区切りは codePointAt と同じ (上位サロゲートの直後が下位サロゲートのときだけ 1 文字。孤立サロゲートは自分のまま)。
 */
function foldCase(value: string, { canonical, bmp }: CaseTable): string {
  const units = new Uint16Array(value.length);
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const codePoint = (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        const target = canonical.get(codePoint) ?? codePoint;
        if (target !== codePoint) changed = true;
        units[index] = 0xd800 + ((target - 0x10000) >> 10);
        units[index + 1] = 0xdc00 + ((target - 0x10000) & 0x3ff);
        index += 1;
        continue;
      }
    }
    const target = bmp[unit];
    if (target !== unit) changed = true;
    units[index] = target;
  }
  if (!changed) return value;
  const pieces: string[] = [];
  for (let start = 0; start < units.length; start += DECODE_CHUNK) {
    // 展開 (...) は型付き配列の反復子を回すので 7 倍ほど遅い。apply は配列のように読む。
    pieces.push(Reflect.apply(String.fromCharCode, null, units.subarray(start, start + DECODE_CHUNK)) as string);
  }
  return pieces.join('');
}

/**
 * 直前にたたんだ本文とその結果。1 回の置き換えでは、根・LONG の名前・最後の網が同じ本文を続けて探すので、たたむのは 1 回で済む。
 * 純粋な関数の結果を覚えるだけなので、一致の結果は変わらない。本文は手元のパスやトークンを含みうるので、組み立ての終わりに
 * forgetFoldedText で捨てる (公開には出ないが、次の組み立てまでメモリに残さない)。
 */
let lastText: string | undefined;
let lastFolded = '';

/** 覚えている本文とたたみを捨てる (buildPublicIssueBody の終わりで呼ぶ)。 */
export function forgetFoldedText(): void {
  lastText = undefined;
  lastFolded = '';
}

function foldText(text: string, caseTableValue: CaseTable): string {
  if (text !== lastText) {
    lastFolded = foldCase(text, caseTableValue);
    lastText = text;
  }
  return lastFolded;
}

/** 大文字小文字を区別せずに探す鍵 1 つ (根なら直後の文字の条件つき)。 */
export interface CaseInsensitiveLiteral {
  /** たたんだ鍵 (表が使えるとき)。 */
  readonly folded: string;
  /** 表が使えないときの正規表現 (先読みの中で鍵を捕獲し、重なる出現も拾う)。 */
  readonly fallback: RegExp | undefined;
  readonly codePoints: number;
  readonly root: boolean;
}

export function caseInsensitiveLiteral(value: string, root: boolean): CaseInsensitiveLiteral {
  const caseTableValue = caseTable();
  const codePoints = Array.from(value).length;
  if (caseTableValue === null) {
    // 表が使えないエンジンの退避。重なる出現も拾えるよう、鍵は先読みの中で捕獲する (根の直後の文字の条件も先読みの中、捕獲の外)。
    const suffix = root ? '(?![\\p{L}\\p{N}_-])' : '';
    return { folded: value, fallback: new RegExp(`(?=(${escapeRegExp(value)})${suffix})`, 'giu'), codePoints, root };
  }
  return { folded: foldCase(value, caseTableValue), fallback: undefined, codePoints, root };
}

/**
 * 本文を鍵と同じ代表にたたんだもの (UTF-16 の長さと位置は変わらない)。同じ本文は 1 回だけたたむ。表が使えないエンジンでは本文そのまま
 * (そのとき鍵は fallback の正規表現で探す)。探し方は issue-public-literal-search.ts。
 */
export function foldedTextOf(text: string): string {
  const caseTableValue = caseTable();
  return caseTableValue === null ? text : foldText(text, caseTableValue);
}
