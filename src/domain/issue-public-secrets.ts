/**
 * 秘密らしい文字列の「形」で見つける (bdboard-4y8q.2、docs/ISSUE-REPORTING.md 5節の置き換え規則 4・5)。
 * 見つけるだけで、書き換えは issue-public-redact.ts。どの finder も `{ start, end }` (UTF-16 の半開区間) を返す。
 *
 * 網羅的な一覧ではない: 各サービスの最新の鍵書式は変わるし、形を持たない秘密 (パスワード・独自の API キー) は
 * 見つけられない。ここに無い形は、最後の網 (issue-public-leaks.ts) も同じ finder を使うので拾えない。
 * 最終的な防御は「投稿の前に人が見る」こと。
 *
 * 線形であること: 入力は他人が書いたログで、100k 文字の敵対的な入力を通す。したがって
 *   - 正規表現は定数 (`g` フラグ)。`matchAll` は内部でコピーを使うので lastIndex の状態を共有しない。
 *   - 上限なしの量指定子 (`+` `{n,}`) は、直後に「その文字クラスに入らない文字」か末尾が来る 1 つの文字クラスだけで、
 *     失敗しても後戻りで別の分割を試さない (入れ子の量指定子・重なる選択肢を作らない)。
 *   - 同じ文字が続く場所で開始位置が何度も試されないよう、必要なものには後読みで「連の先頭だけ」に制限する。
 */

export interface SecretSpan {
  readonly start: number;
  readonly end: number;
}

export interface TokenShape {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * トークンの形の表 (名前・正規表現)。どれも「長いランダム列」の前に、サービス固有の接頭辞がある。
 * 誤検出 (ふつうの文章を消す) と取りこぼし (秘密を残す) の釣り合いは、接頭辞の固有さと長さの下限で取る。
 */
export const TOKEN_SHAPES: readonly TokenShape[] = [
  // GitHub の古典的なトークン: ghp_ (個人)・gho_ (OAuth)・ghu_ (user-to-server)・ghs_ (server-to-server)・
  // ghr_ (refresh)。本体は英数字 36 文字程度だが、将来の長さの変更に備えて 20 以上とする。誤検出: ほぼ無い。
  { name: 'github', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  // GitHub の fine-grained PAT: github_pat_ + 英数字と _ (82 文字程度)。_ を含むので別の形にする。
  { name: 'github-fine-grained', pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
  // sk- 系: OpenAI の旧形式 (sk- + 英数字)、sk-proj-・sk-svcacct- (- と _ を含む)、Anthropic の sk-ant-… (その部分集合)。
  // 文字クラスに _ - を含めるので、プロジェクトのキーが途中までしか消えない事故が起きない。
  // 後読みは "task-force-…" のような語の途中の "sk-" を除く (直前が英数字なら対象外)。誤検出: "risk-assessment-…" 等は直前が英字で除かれる。
  { name: 'sk-family', pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g },
  // AWS のアクセスキー ID: AKIA (長期) / ASIA (STS の一時) + 英大文字と数字ちょうど 16 文字。
  { name: 'aws-access-key-id', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  // Slack のトークン: xoxb (bot)・xoxa・xoxp (user)・xoxr (refresh)・xoxs (session) + 英数字と -。10 以上は意図して緩め。
  { name: 'slack', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  // Google API キー: AIza + URL 安全な文字ちょうど 35 文字。
  { name: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  // npm のアクセストークン: npm_ + 英数字ちょうど 36 文字。
  { name: 'npm', pattern: /npm_[A-Za-z0-9]{36}/g },
  // 一般の "Authorization: Bearer <token>"。16 文字以上を求め、"Bearer authentication" のような文章を消さない。
  // 値と末尾の = (base64 の詰め物) は互いに素な文字クラスなので、どちらも後戻りしない。
  { name: 'bearer', pattern: /\bBearer[ \t]{1,16}[A-Za-z0-9._~+/-]{16,}=*/gi },
];

// 秘密鍵ブロックの両端 (PEM)。"RSA PRIVATE KEY"・"EC PRIVATE KEY"・"OPENSSH PRIVATE KEY"・"ENCRYPTED PRIVATE KEY" など。
// 名前の部分は {0,40} で上限を付け、"-----BEGIN " の直後の空白が長く続く入力でも先読みが伸びないようにする。
const BEGIN_PRIVATE_KEY = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const END_PRIVATE_KEY = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;

// メールアドレス。後読みで、ローカル部の文字の連の「先頭」だけを開始位置にする。これが無いと、長い英数字の連
// ("a" を 10 万個) の各位置から開始して "@" を探し、2 乗になる。ドメインの各ラベルは "." を含まない互いに素な連で、
// ラベルの間は "." だけなので、後戻りしても分割は 1 通り。誤検出: "name@2x.png" のような名前も消えるが、公開本文では過剰な除去を選ぶ。
const EMAIL = /(?<![\p{L}\p{N}_.+-])[\p{L}\p{N}_.+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

function spansFor(text: string, pattern: RegExp): SecretSpan[] {
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

/** TOKEN_SHAPES のすべての形の出現位置 (形どうしで重なりうる。統合は redact 側)。 */
export function findTokenSpans(text: string): SecretSpan[] {
  return TOKEN_SHAPES.flatMap(({ pattern }) => spansFor(text, pattern));
}

/**
 * 秘密鍵ブロックを BEGIN から END まで。END が無い (ログが途中で切れた) ときは、BEGIN から文章の終わりまでを
 * ブロックとして扱い、そこで走査を止める (鍵の本体が残るより、後ろを消しすぎるほうを選ぶ)。
 * 線形: BEGIN ごとに END を「その BEGIN の後ろ」から探すが、END 用の正規表現の lastIndex は前へ戻さないので、
 * BEGIN が何千あっても各文字を高々 1 回ずつ走査する (BEGIN ごとの遅延量指定子 `[\s\S]*?` は使わない)。
 */
export function findPrivateKeySpans(text: string): SecretSpan[] {
  const begins = new RegExp(BEGIN_PRIVATE_KEY.source, BEGIN_PRIVATE_KEY.flags);
  const ends = new RegExp(END_PRIVATE_KEY.source, END_PRIVATE_KEY.flags);
  const spans: SecretSpan[] = [];
  let begin = begins.exec(text);
  while (begin !== null) {
    ends.lastIndex = Math.max(ends.lastIndex, begin.index + begin[0].length);
    const end = ends.exec(text);
    if (end === null) {
      spans.push({ start: begin.index, end: text.length });
      break;
    }
    spans.push({ start: begin.index, end: end.index + end[0].length });
    begins.lastIndex = Math.max(begins.lastIndex, end.index + end[0].length);
    begin = begins.exec(text);
  }
  return spans;
}

/** メールアドレスの出現位置 (非 ASCII の文字も許す)。 */
export function findEmailSpans(text: string): SecretSpan[] {
  return spansFor(text, EMAIL);
}
