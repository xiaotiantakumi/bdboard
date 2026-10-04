/**
 * 秘密らしい文字列の「形」で見つける (bdboard-4y8q.2、docs/ISSUE-REPORTING.md 5節の置き換え規則 5・6)。
 * 見つけるだけで、書き換えは issue-public-redact.ts。どの finder も `{ start, end }` (UTF-16 の半開区間) を返す。
 * 秘密鍵ブロックは issue-public-pem.ts、ホームのパスは issue-public-home.ts。
 *
 * 網羅的な一覧ではない: 各サービスの最新の鍵書式は変わるし、形を持たない秘密 (パスワード・独自の API キー) は見つけられない。
 * 最後の網 (issue-public-leaks.ts) は、置き換えと同じ形に加えて「緩い版」(下の looseSource と DETECT_ONLY_SHAPES) をかけ、
 * 置き換えの形から漏れたもの (英数字が直前に貼り付いた sk-・Bearer、小文字の akia) を報告だけする。
 * 最終的な防御は「投稿の前に人が見る」こと。
 *
 * 直前の条件 RUN_START: "task-force-…" のような語の途中の "sk-" は秘密ではないので、直前が ASCII の英数字なら対象外にする。
 * ただし JSON に埋め込まれたログの "\n" "\t" "\r" (バックスラッシュと n/t/r) と、URL の "%3D" "%20" のようなパーセント表記は、
 * 末尾が英数字なので同じ規則だと除外されてしまう (実際のエラー文に多い形)。だから「直前がその文字列」のときも許す。
 * どちらも固定長の後読みで、後戻りしない。
 *
 * 線形であること: 入力は他人が書いたログで、100k 文字の敵対的な入力を通す。したがって
 *   - 正規表現の元 (source) だけを定数にし、呼び出しのたびに作る。`g` フラグの RegExp オブジェクトを出すと、呼び出し側の
 *     `.test()` が lastIndex を進め、`matchAll` がその位置から始めて先頭のトークンを黙って飛ばす (レビューで再現)。
 *   - 上限なしの量指定子 (`+` `{n,}`) は、直後に「その文字クラスに入らない文字」か末尾が来る 1 つの文字クラスだけで、
 *     失敗しても後戻りで別の分割を試さない (入れ子の量指定子・重なる選択肢を作らない)。
 *   - 同じ文字が続く場所で開始位置が何度も試されないよう、必要なものには後読みで「連の先頭だけ」に制限する (JWT・メール)。
 */

export interface SecretSpan {
  readonly start: number;
  readonly end: number;
}

export interface TokenShape {
  readonly name: string;
  /** 置き換えに使う正規表現の元。 */
  readonly source: string;
  readonly flags: string;
  /** 最後の網だけが使う、緩めた版の元 (flags は同じ)。無ければ source と同じ。 */
  readonly looseSource?: string;
}

const RUN_START = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrt]|%[0-9A-Fa-f]{2}))`;
const JWT_START = String.raw`(?:(?<![A-Za-z0-9_-])|(?<=\\[nrt]|%[0-9A-Fa-f]{2}))`;

/**
 * トークンの形の表。どれも「長いランダム列」の前に、サービス固有の接頭辞がある。
 * 誤検出 (ふつうの文章を消す) と取りこぼし (秘密を残す) の釣り合いは、接頭辞の固有さと長さの下限で取る。
 */
export const TOKEN_SHAPES: readonly TokenShape[] = Object.freeze(
  [
    // GitHub の古典的なトークン: ghp_ (個人)・gho_ (OAuth)・ghu_ (user-to-server)・ghs_ (server-to-server)・
    // ghr_ (refresh)。本体は英数字 36 文字程度だが、将来の長さの変更に備えて 20 以上とする。接頭辞が固有なので直前の条件は無し。
    { name: 'github', source: String.raw`gh[pousr]_[A-Za-z0-9]{20,}`, flags: 'g' },
    // GitHub の fine-grained PAT: github_pat_ + 英数字と _ (82 文字程度)。_ を含むので別の形にする。
    { name: 'github-fine-grained', source: String.raw`github_pat_[A-Za-z0-9_]{20,}`, flags: 'g' },
    // sk- 系: OpenAI の旧形式 (sk- + 英数字)、sk-proj-・sk-svcacct- (- と _ を含む)、Anthropic の sk-ant-… (その部分集合)。
    // 文字クラスに _ - を含めるので、キーが途中までしか消えない事故が起きない。誤検出: "risk-assessment-…" 等は直前が英字で除かれる。
    // 最後の網は直前の条件を外した版で、"id1sk-…" のように貼り付いたものを報告する。
    {
      name: 'sk-family',
      source: `${RUN_START}sk-[A-Za-z0-9_-]{20,}`,
      looseSource: String.raw`sk-[A-Za-z0-9_-]{20,}`,
      flags: 'g',
    },
    // Stripe: sk_live_・rk_live_ (restricted) + 英数字。
    // 最後の網は直前の条件を外した版 ("key1sk_live_…" のように貼り付いたものを報告する)。
    {
      name: 'stripe',
      source: `${RUN_START}[sr]k_live_[A-Za-z0-9]{16,}`,
      looseSource: String.raw`[sr]k_live_[A-Za-z0-9]{16,}`,
      flags: 'g',
    },
    // AWS のアクセスキー ID: AKIA (長期) / ASIA (STS の一時) + 英大文字と数字ちょうど 16 文字。
    // 最後の網は小文字も報告する (大文字小文字を区別しない版)。
    {
      name: 'aws-access-key-id',
      source: String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`,
      looseSource: String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}|(?:akia|asia)[0-9a-z]{16}`,
      flags: 'g',
    },
    // Slack: xoxb (bot)・xoxa・xoxe・xoxp (user)・xoxr (refresh)・xoxs (session) と、xapp (app-level) + 英数字と -。10 以上は意図して緩め。
    { name: 'slack', source: String.raw`(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}`, flags: 'g' },
    // Google API キー: AIza + URL 安全な文字ちょうど 35 文字。OAuth のアクセストークン: ya29. + 20 文字以上。
    { name: 'google-api-key', source: String.raw`AIza[0-9A-Za-z_-]{35}`, flags: 'g' },
    { name: 'google-oauth', source: String.raw`ya29\.[A-Za-z0-9_-]{20,}`, flags: 'g' },
    // npm のアクセストークン: npm_ + 英数字ちょうど 36 文字。
    { name: 'npm', source: String.raw`npm_[A-Za-z0-9]{36}`, flags: 'g' },
    // JWT: eyJ… . eyJ… . 署名。直前が「連の先頭」のときだけ開始するので、"eyJ" の繰り返しの 10 万文字でも 1 ms (2 乗にならない)。
    // 最後の網は、直前に文字が貼り付いた形 ("id1eyJ…"・"id_eyJ…") も報告する。先頭の "eyJ…" から読む緩い版は "eyJ" の繰り返しで
    // 2 乗になるので、2 つ目の部分 ".eyJ….署名" だけを読む (文字クラスに "." を含まないので、読む長さは次の "." までで止まる)。
    {
      name: 'jwt',
      source: `${JWT_START}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`,
      looseSource: `${JWT_START}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}|\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`,
      flags: 'g',
    },
    // 一般の "Authorization: Bearer <token>"。16 文字以上を求め、"Bearer authentication" のような文章を消さない。
    // 区切りは空白・タブ・"%20" (どちらも値の文字クラスに入らないので、後戻りしない)。値と末尾の = は互いに素な文字クラス。
    // 最後の網は直前の条件を外した版 ("xBearer …" も報告する)。
    {
      name: 'bearer',
      source: String.raw`${RUN_START}Bearer(?:[ \t]|%20){1,16}[A-Za-z0-9._~+/-]{16,}=*`,
      looseSource: String.raw`Bearer(?:[ \t]|%20){1,16}[A-Za-z0-9._~+/-]{16,}=*`,
      flags: 'gi',
    },
  ].map((shape) => Object.freeze(shape)),
);

function spansFor(text: string, source: string, flags: string): SecretSpan[] {
  return [...text.matchAll(new RegExp(source, flags))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * TOKEN_SHAPES のすべての形の出現位置 (形どうしで重なりうる。統合は呼び出し側)。loose = true は最後の網用の緩めた版
 * (looseSource があればそれを使う。置き換えの形の上位集合なので、同じ一致は同じ範囲で出る)。
 */
export function findTokenSpans(text: string, loose = false): SecretSpan[] {
  return TOKEN_SHAPES.flatMap(({ source, looseSource, flags }) =>
    spansFor(text, loose ? (looseSource ?? source) : source, flags),
  );
}

/**
 * メールアドレス。後読みで、ローカル部の文字の連の「先頭」だけを開始位置にする。これが無いと、長い英数字の連
 * ("a" を 10 万個) の各位置から開始して "@" を探し、2 乗になる。"@" の代わりに URL のパーセント表記 "%40" と全角の "＠" も許す
 * (クエリ文字列の "email=a%40b.com" や全角で書かれたもの)。ドメインの各ラベルは "." を含まない互いに素な連で、
 * ラベルの間は "." だけなので、後戻りしても分割は 1 通り。ドットの無いドメイン ("admin@example-box") は見つけない
 * (ふつうの "user@host" の記述を消しすぎる。documented)。誤検出: "name@2x.png" のような名前も消えるが、公開本文では過剰な除去を選ぶ。
 */
// 最後のラベル (TLD) は文字で始まる: "react@18.2.0"・"typescript@5.6.3"・"react@19.0.0-rc.1" のようなパッケージの版は、メールではない
// (ラベルにはハイフンも入るので、"0-rc" のように文字を含むだけの版を TLD と読まないよう、先頭が文字であることを求める)。
// 最後のラベルの後ろに "." と英数字が続く切れ方は取らない (版の途中でメールを切り取って "<email>.1" を残さない)。
// 当たらない切れ方に当たると、手前のラベルへ 1 つずつ戻って試すだけ (ラベルの数に比例。2 乗にならない)。
// ssh の宛先 "deploy@10.0.0.5" は、数字だけでも IPv4 の形 (各 1〜3 桁の 4 つ) なら今までどおりメールとして消す。
const EMAIL_LOCAL = String.raw`(?<![\p{L}\p{N}_.+-])[\p{L}\p{N}_.+-]+(?:@|%40|＠)`;
const EMAIL_DOMAIN = String.raw`[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}[\p{L}\p{N}-]*(?![\p{L}\p{N}-]|\.[\p{L}\p{N}])`;
const EMAIL_IPV4 = String.raw`(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![\p{L}\p{N}-])`;
const EMAIL_SOURCE = `${EMAIL_LOCAL}(?:${EMAIL_DOMAIN}|${EMAIL_IPV4})`;

/** メールアドレスの出現位置 (非 ASCII の文字も許す)。 */
export function findEmailSpans(text: string): SecretSpan[] {
  return spansFor(text, EMAIL_SOURCE, 'gu');
}
