/**
 * 公開本文用の、ホーム配下のパスの探索 (bdboard-4y8q.2、docs/ISSUE-REPORTING.md 5節の置き換え規則 2)。
 *
 * issue-draft-identifier.ts の foldHomePaths は指紋の計算に使われるため、開始位置の条件 (PATH_START: 行頭・空白・引用符など
 * の直後だけ) を変えられない。そのままでは、日本語の句読点や文字の直後 (「/Users/jdoe/x」)・JSON の \n \t の直後・
 * Vite の /@fs/Users/…・vscode://file/Users/…・`* @ ! + # & ? .` の直後にあるパスを畳めず、ユーザー名が公開本文に残る。
 * ここでは、本体 (名前の読み方と終わり) は同じものを使い、開始位置の条件だけを緩める:
 *   - 直前が ASCII の英数字でないこと (CJK の文字・句読点・記号・行頭はすべて可)、または
 *   - 直前が JSON/ログの改行・タブの文字列 (\n \r \t)・URL のパーセント表記 (%0A など)・"@fs"・"file" (大文字小文字は問わない)・
 *     1 文字のフラグ ("-I/Users/…"・"-L/home/…": コンパイラ・リンカの出力に実際に出る)。
 * 上のどれでもなく直前が ASCII の英数字のもの ("/api/users/42"・"src/users/x.ts"・"12:00:00/Users/jdoe/x") は、置き換えない。
 * ふつうの URL・相対パスを壊さないため。ただし置き換えないだけで見逃しはしない: 最後の網は開始位置の条件なしの緩い版
 * (findLooseHomeRanges) で、そのようなパスを報告する。公開本文では過剰な除去を選ぶので、"profile/home/x" のように
 * "file" の直後の "/home/x" は畳まれうる。
 *
 * パーセント表記 ("%2FUsers%2Fjdoe", "C%3A%5CUsers%5Cjdoe"): 区切りは %2F と %5C。"Users" は大文字小文字を問わない。名前は
 * %XX (区切りの %2F・%5C を除く) と ASCII の通常の文字で、日本語の名前 ("%E5%B0%8F…") や空白 ("%20") も含めて 1 つの名前になる。
 *
 * 正規表現は定数 (lastIndex を共有しない): 呼び出しのたびに作る。開始位置の条件は固定長の後読みだけで、
 * 本体は foldHomePaths と同じく線形 (10 万文字の敵対的な入力のテストで確かめる)。
 */
import { HOME_PATH_BODY_SOURCE } from './issue-draft-identifier.js';

const START = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrt]|%[0-9A-Fa-f]{2}|@fs|[Ff][Ii][Ll][Ee]|(?:^|[\s'",])-[A-Za-z]))`;
const PERCENT_SEPARATOR = String.raw`%(?:2[Ff]|5[Cc])`;
/** 名前: %XX (区切りの %2F・%5C 以外) か、% でも空白・引用符・区切りでもない文字。2 つの選択肢は先頭の文字が重ならない。 */
const PERCENT_NAME = String.raw`(?:%(?!2[Ff]|5[Cc])[0-9A-Fa-f]{2}|[^%\s'"` + '`' + String.raw`<>&\\/])+`;
const PERCENT_ENCODED = `${PERCENT_SEPARATOR}(?:[Uu][Ss][Ee][Rr][Ss]|home)${PERCENT_SEPARATOR}${PERCENT_NAME}`;
/**
 * 最後の網の緩い版: 開始位置の条件なし。大文字小文字を区別する "Users" と "home" だけ (小文字の "users" は URL の経路に多すぎる)。
 * 名前は 1 つの文字クラスの連なりで、直後に何も続かないので後戻りしない。
 */
const LOOSE_HOME =
  String.raw`(?:[A-Za-z]:[\\/]+Users[\\/]+|/(?:Users|home)/)[^\\/\s'"` + '`' + String.raw`:;,|<>()[\]{}=]+`;

export interface HomeRange {
  readonly start: number;
  readonly end: number;
}

function rangesOf(text: string, source: string): HomeRange[] {
  return [...text.matchAll(new RegExp(source, 'g'))].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

export function findPublicHomeRanges(text: string): HomeRange[] {
  return rangesOf(text, `${START}${HOME_PATH_BODY_SOURCE}|${PERCENT_ENCODED}`);
}

/** 置き換えない形も含めて「ホームのパスらしい」ものを報告する (最後の網用。置き換えには使わない)。 */
export function findLooseHomeRanges(text: string): HomeRange[] {
  return rangesOf(text, LOOSE_HOME);
}
