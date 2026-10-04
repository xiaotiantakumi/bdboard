/**
 * 公開本文用の、ホーム配下のパスの探索 (bdboard-4y8q.2、docs/ISSUE-REPORTING.md 5節の置き換え規則 2)。
 *
 * issue-draft-identifier.ts の foldHomePaths は指紋の計算に使われるため、開始位置の条件 (PATH_START: 行頭・空白・引用符など
 * の直後だけ) を変えられない。そのままでは、日本語の句読点や文字の直後 (「/Users/jdoe/x」)・JSON の \n \t の直後・
 * Vite の /@fs/Users/…・vscode://file/Users/…・`* @ ! + # & ? .` の直後にあるパスを畳めず、ユーザー名が公開本文に残る。
 * ここでは、本体 (名前の読み方と終わり) は同じものを使い、開始位置の条件だけを緩める:
 *   - 直前が ASCII の英数字でないこと (CJK の文字・句読点・記号・行頭はすべて可)、または
 *   - 直前が JSON/ログの改行・タブの文字列 (\n \r \t)・URL のパーセント表記 (%0A など)・"@fs"・"file" (大文字小文字は問わない)。
 * 直前が ASCII の英数字のもの ("/api/users/42"・"src/users/x.ts") は、ふつうの URL・相対パスなので畳まない
 * (上の例外を除く)。公開本文では過剰な除去を選ぶので、"profile/home/x" のように "file" の直後の "/home/x" は畳まれうる。
 *
 * 正規表現は定数 (lastIndex を共有しない): 呼び出しのたびに作る。開始位置の条件は固定長の後読みだけで、
 * 本体は foldHomePaths と同じく線形 (10 万文字の敵対的な入力のテストで確かめる)。
 */
import { HOME_PATH_BODY_SOURCE } from './issue-draft-identifier.js';

const START = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrt]|%[0-9A-Fa-f]{2}|@fs|[Ff][Ii][Ll][Ee]))`;
/** "%2FUsers%2Fjdoe%2Fx" のように / が %2F になった形 (クエリの値)。名前は次の % か空白・引用符まで。 */
const PERCENT_ENCODED = String.raw`%2[Ff](?:Users|home)%2[Ff][^%\s'"` + '`' + String.raw`<>&\\/]+`;

export interface HomeRange {
  readonly start: number;
  readonly end: number;
}

export function findPublicHomeRanges(text: string): HomeRange[] {
  const pattern = new RegExp(`${START}${HOME_PATH_BODY_SOURCE}|${PERCENT_ENCODED}`, 'g');
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}
