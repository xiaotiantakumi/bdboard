/**
 * 呼び出し側が渡す「名前」の整形 (bdboard-4y8q.1、docs/ISSUE-REPORTING.md 3・4節)。
 *
 * source・catalogSlug・版の文字列・プロジェクト名・見送りの理由は、題名・本文・指紋・トンネルの
 * 読み手への応答にそのまま出る。ここは純粋な文字列の関数だけで、次の二つを受け持つ:
 *   1. 1 行であること (改行・制御文字・不可視の書式文字を持たない)。
 *   2. 利用者のホーム配下の絶対パスから、ユーザー名を消すこと ("~/" に畳む)。
 * どちらも best-effort の入口の絞りで、公開本文の置き換えと Markdown のエスケープは 4y8q.2 の仕事。
 */

/**
 * 1 行の文字列として扱えない文字: 制御文字 (Cc: 改行・タブ・DEL・C1)、書式文字 (Cf: ゼロ幅、
 * 双方向制御、BOM、ソフトハイフン、ALM、単語結合子と不可視の演算子、タグ文字、U+180E など)、
 * 行・段落の区切り (Zl・Zp)、見えない埋め字 (ハングルの U+115F・U+1160・U+3164・U+FFA0)、
 * タグ文字の区画全体 (U+E0000-E007F。割り当て前の番号も含めて閉じる)。
 * 画面で並びを入れ替えたり、見えない文字で別の値に見せかけたり、行を足したりできる。
 *
 * 異体字選択子 (Mn。日本語の IVS を含む)・結合文字 (濁点の分解形)・各種スペース (Zs。
 * 全角スペース U+3000 を含む) は普通の文字なので許す。孤立したサロゲートは見ない (4y8q.2)。
 */
const DISALLOWED_IN_SINGLE_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u{E0000}-\u{E007F}]/u;
const DISALLOWED_IN_SINGLE_LINE_GLOBAL = new RegExp(DISALLOWED_IN_SINGLE_LINE.source, 'gu');

/** 絵文字の連結 (ZWJ) と、ペルシャ語などの字形制御 (ZWNJ)。人が書く表示用の欄では普通に出てくる。 */
const JOINERS = /[\u200C\u200D]/g;
/** コピー&ペーストで混ざる幅ゼロの文字 (ZWSP と BOM)。 */
const PASTE_ARTIFACTS = /[\u200B\uFEFF]/g;

/**
 * 改行・制御文字・不可視の書式文字を含まない 1 行の文字列か。識別子 (source・catalogSlug・版の
 * 文字列・sourceTicketRef) は、HTTP の入口でこれを満たさないものを 400 にする (行を足して見出しや
 * リンクを紛れ込ませる経路、見えない文字で別の値に見せかける経路を作らない)。
 * 1 行でもリンク・@メンション・#参照・<img> は書ける。インラインの Markdown のエスケープは
 * 公開本文を組む bdboard-4y8q.2 の仕事で、ここは行の数と見えない文字だけを見る。
 */
export function isSingleLineText(value: string): boolean {
  return !DISALLOWED_IN_SINGLE_LINE.test(value);
}

/** 見送りの理由 (人が書く一言) 用: ZWSP と BOM は貼り付けの混入として落とし、ZWJ・ZWNJ は許す。 */
export function stripPasteArtifacts(value: string): string {
  return value.replace(PASTE_ARTIFACTS, '');
}

/** 見送りの理由の 1 行検査。ZWJ・ZWNJ は許し、そのほかは isSingleLineText と同じ。 */
export function isSingleLineDisplayText(value: string): boolean {
  return isSingleLineText(value.replace(JOINERS, ''));
}

/** 1 行の検査で弾く文字をすべて取り除く (改行も取り除くので、結果は 1 行になる)。 */
export function stripNonLineText(value: string): string {
  return value.replace(DISALLOWED_IN_SINGLE_LINE_GLOBAL, '');
}

// ---- ホーム配下の絶対パス ----------------------------------------------------------------------

/** 直前が、行頭・空白・区切り記号・"file://"・"\\?\" のどれか (パスの先頭として読める位置)。 */
const PATH_START = /(?<=^|[\s'"`=:(,;|<>[{]|file:\/\/\/?|\\\\\?\\)/;
/**
 * 名前が止まる文字は、区切り (/ \)・空白・引用符のほか、リストの区切りと括りの閉じ (` : ; , | < > ) [ ] { } =)。
 * 名前の欄はこれらを含まないので、"/home/u:/home/u/bin" や "x=/Users/u;y=/Users/u/z" は名前ごとに畳まれ、
 * 区切りの先の文字は残る。次の PATH_END は、名前の後ろが区切りの連なりか、これらの止まる文字か、文字列の終わりであることを求める。
 */
const PATH_END = /(?:[\\/]+|(?=[\s'"`:;,|<>)[\]{}=]|$))/;

/**
 * Windows: C:\Users\<名前>、C:/Users/<名前>。大文字小文字は区別しない。名前には半角スペースだけ許す
 * (John Smith)。改行・タブなどの空白は名前に入れないので、複数行の本文でも次の行を巻き込まない。
 * ただし半角スペースの直後が "X:\"・"X:/" (ドライブ文字) か "/"・"\" のときは、そのスペースで名前を終える。
 * 次のパスの頭を名前として飲み込むと、"cd C:\Users\u && node C:\Users\u\x.js" が "cd ~/:\Users\u\x.js" になり、
 * 次のパスのユーザー名が残るため (bdboard-4lea)。終えたあとの次のパスは、空白の直後なので別に畳まれる。
 */
const WINDOWS_HOME =
  /[A-Za-z]:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]+(?:[^\\/\s'"`:;,|<>)[\]{}=]| (?![A-Za-z]:[\\/]|[\\/]))+/;
/** WSL から Windows 側を見たパス: \\wsl$\<distro>\home\<名前>、\\wsl.localhost\<distro>\home\<名前>。 */
const WSL_UNC_HOME =
  /\\\\wsl(?:\$|\.localhost)[\\/]+[^\\/\s'"]+[\\/]+home[\\/]+[^\\/\s'"`:;,|<>)[\]{}=]+/;
/**
 * POSIX: /Users/<名前> (macOS。マウント先と大文字小文字違いも)、/home/<名前> (Linux)。
 * 前に付く形: /mnt/c (WSL)、/c (Git Bash)、/cygdrive/c、/System/Volumes/Data、/Volumes/<ディスク名>
 * (macOS)、/var と /usr (/var/home・/usr/home)。macOS は大文字小文字を区別しないので /users/ も畳む。
 */
const POSIX_HOME =
  /(?:\/(?:mnt\/|cygdrive\/)?[A-Za-z](?=\/[Uu][Ss][Ee][Rr][Ss]\/)|\/System\/Volumes\/Data(?=\/[Uu][Ss][Ee][Rr][Ss]\/)|\/Volumes\/(?:[^/\s'"]| )+(?=\/[Uu][Ss][Ee][Rr][Ss]\/)|\/(?:var|usr)(?=\/home\/))?\/(?:[Uu][Ss][Ee][Rr][Ss]|home)[\\/]+[^\\/\s'"`:;,|<>)[\]{}=]+/;

const HOME_PATH_PATTERN = new RegExp(
  `${PATH_START.source}(?:${WINDOWS_HOME.source}|${WSL_UNC_HOME.source}|${POSIX_HOME.source})${PATH_END.source}`,
  'g',
);

/**
 * 文字列の中の、利用者のホーム配下の絶対パスを "~/" に畳む (前後の空白は触らない。題名・本文用)。
 * 畳む形は次のとおりで、これ以外は見つけない:
 *   /Users/<名前>、/home/<名前>、/var/home/<名前>、/usr/home/<名前> (/users/ も)
 *   /mnt/c/Users/<名前> (WSL)、/c/Users/<名前> (Git Bash)、/cygdrive/c/Users/<名前>
 *   /System/Volumes/Data/Users/<名前>、/Volumes/<ディスク名>/Users/<名前>
 *   C:\Users\<名前>、C:/Users/<名前> (JSON 内の C:\\Users\\ も)、\\?\C:\Users\<名前>、file:///C:/Users/<名前>
 *   \\wsl$\<distro>\home\<名前>、\\wsl.localhost\<distro>\home\<名前>
 * パスとして読むのは、直前が行頭・空白・' " ` = : ( , ; | < > [ {・"file://"・"\\?\" のときだけ。
 * だから "GET /api/home/x" や "POST /api/Users/42" のように途中に現れるものは触らない
 * (行頭や空白の直後の "/Users/42" と "/home/x" は畳む)。名前は、区切り (/ \)・空白・引用符・
 * ` : ; , | < > ) [ ] { } = のどれかか文字列の終わりで終わる (PATH 風の "/home/u:/home/u/bin" や
 * "x=/Users/u;y=/Users/u/z" は名前ごとに畳み、区切りの先は残す)。Windows の名前だけは半角スペースを含みうるので、
 * 上の止まる文字か行の終わりまで名前として読む: "bash C:\Users\u --flag" は "bash ~/" になる
 * (引数を残すより、ユーザー名を残さないことを優先する)。ただし半角スペースの直後が "X:\"・"X:/" か "/"・"\" なら
 * そこで名前を終える: "cd C:\Users\u && node C:\Users\u\x.js" は "cd ~/ ~/x.js"、
 * "cp C:\Users\u /home/u/x" は "cp ~/ ~/x" (次のパスも別に畳む)。"/Users/Shared"・"C:\Users\Public"・
 * "/home/linuxbrew" のような共有の場所も同じ形なので畳まれる。パス以外の秘密 (引数のトークンなど) と、
 * "~name/" の形は見つけない。
 *
 * 既知の取りこぼし (docs/ISSUE-REPORTING.md、bdboard-4lea): ` ) { } ' は Windows のアカウント名に使えるが、上の止まる文字
 * でもあるので、名前の途中にあると、そこから先の名前が残る ("C:\Users\O'Brien\x" は "~/'Brien\x"。名前が "{" で
 * 始まる "C:\Users\{bob}\x" は畳めない)。これらを Windows の名前の中だけ許すと、パスの直後に付く閉じ括弧・閉じ引用符・
 * 閉じバッククォート ("(C:\Users\u)"・"`C:\Users\u` and more") を名前に巻き込み、区切りの先を消す
 * ("C:\Users\u)rest" が "~/)rest" になる、名前の終わりの記号のテストとも両立しない)。名前の一部が残る割り切りを、
 * 区切りの先を壊さないために受け入れた。
 */
export function foldHomePaths(value: string): string {
  return value.replace(HOME_PATH_PATTERN, '~/');
}

/** 文字列の値だけ foldHomePaths にかける (版の文字列の組 DraftEnvInfo 用。文字列でない値と欄の並びはそのまま)。 */
export function foldHomePathsInValues<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, typeof value === 'string' ? foldHomePaths(value) : value]),
  ) as T;
}

/**
 * 識別子 (source・catalogSlug・版の文字列) の整形: 前後の空白を落とし、ホーム配下のパスを "~/" に畳む。
 * 指紋の前にかけるので、別の利用者・別の PC の同じフックが 1 件にまとまる。
 */
export function canonicalizeIdentifier(value: string): string {
  return foldHomePaths(value.trim());
}

/**
 * パスの先頭の境界としても読める、1 行の検査で弾く文字。取り除くと前の語に繋がるので空白にする。
 * 改行・タブなどの制御文字 (Cc)・行区切り (Zl・Zp)・BOM のほか、画面では空白に見える文字:
 * ハングルの埋め字 (U+115F・U+1160・U+3164・U+FFA0) と U+180E (モンゴル語の母音区切り。かつて空白だった)。
 * ZWSP (U+200B)・WORD JOINER (U+2060)・ソフトハイフン (U+00AD) など、画面で何も見えない幅ゼロの文字は含めない:
 * 空白に替えると "/Us<ZWSP>ers/name" のような形崩しが畳めなくなる (取り除けば畳める)。また取り除いた結果は、
 * 画面に見える文字列と一致する (手前の語にパスが貼り付いて見えるなら、貼り付いたまま扱う)。
 */
const BOUNDARY_LIKE_DISALLOWED = /[\p{Cc}\p{Zl}\p{Zp}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{180E}\uFEFF]/gu;

/**
 * プロジェクト名 (表示用) の整形。拒否はしない (空になったら呼び出し側が 400 にする)。
 *   1. 改行・タブ・そのほかの制御文字・行区切り・BOM と、画面では空白に見える文字 (ハングルの埋め字・U+180E) は
 *      空白に置き換える。取り除くと前の語に繋がり、"proj<TAB>/Users/u/proj" の "/Users/u/proj" が行頭でも
 *      空白の直後でもなくなって畳まれない ("proj<U+3164>/Users/u/proj" も同じ)。
 *   2. 1 行の検査で弾くそれ以外の文字 (ゼロ幅・双方向制御など) は取り除く。
 *   3. ホーム配下のパスを畳む。2 の後なので、"/Us<ゼロ幅>ers/name" のように見えない文字で形を崩した値も畳まれる。
 *   4. 空白の連なりを 1 つにし、前後を落とす。
 */
export function sanitizeProjectName(value: string): string {
  const spaced = value.replace(BOUNDARY_LIKE_DISALLOWED, ' ');
  return foldHomePaths(stripNonLineText(spaced)).replace(/ {2,}/g, ' ').trim();
}

/**
 * 空白・ZWJ・ZWNJ・結合文字 (\p{M}。異体字選択子・結合用の書記素連結子 U+034F・クメール語の固有母音 U+17B4・
 * IVS の U+E0100 などを含む)・点字の空白 U+2800 を除いて、目に見える文字が 1 つでも残るか。見送りの理由が空に見える
 * 値でないことの確認に使う。結合文字は手前の文字に付いて初めて見えるので、結合文字だけの値は見えない。
 * "e" + U+0301 (é の分解形) は "e" が残るので見える。
 */
export function hasVisibleText(value: string): boolean {
  return value.replace(/[\s\u{2800}\p{M}\u200C\u200D]/gu, '').length > 0;
}
