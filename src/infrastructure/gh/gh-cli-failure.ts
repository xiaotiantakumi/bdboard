// gh の失敗メッセージ文言の判定。PR バッジの reader (gh-cli-pr-status-reader.ts) と
// open issue の reader (gh-cli-external-issue-source.ts) が共有する (bdboard-4y8q.9.2)。

// gh の失敗メッセージ文言 (bdboard-7ln6 #1)。GraphQL/REST どちらの経路でも
// 「rate limit」という語自体は共通して出てくる。HTTP 429 は他の意味を持たない
// ため単独で rate limit 確定として扱う。HTTP 403 は権限/SSOエラーでも返る
// ため単独では rate limit と判定しない — 403 は必ず RATE_LIMIT_TEXT_PATTERNS
// のいずれかと併記されている場合のみ rate limit 扱いとする (実際の gh の
// rate-limit メッセージは "API rate limit exceeded ... (HTTP 403)" のように
// 文言を伴うため、これでも正規の検知漏れは起きない。bdboard-v538)。
const RATE_LIMIT_TEXT_PATTERNS = [
  /api rate limit/i,
  /rate limit exceeded/i,
  /secondary rate limit/i,
];
const RATE_LIMIT_HTTP_429_PATTERN = /\bHTTP\s+429\b/i;

/** gh は認証が要る (未ログイン・トークン無し) ときに exit 4 で終わる。 */
export const GH_EXIT_CODE_AUTH_REQUIRED = 4;

// gh が未ログイン・トークン無効のときに出す文言。認証無しの rate limit の案内には
// "Authenticated requests get a higher rate limit" と書かれるので、`authenticat` のような
// 広い語では判定しない (rate limit は呼び出し側が先に判定するが、ここでも誤検出しない)。
const GH_UNAUTHENTICATED_TEXT_PATTERNS = [
  /gh auth login/i,
  /not logged in/i,
  /authentication required/i,
  /requires authentication/i,
  /\bHTTP\s+401\b/i,
  /bad credentials/i,
  /\b(?:set|export|provide|populate)\b[^.\n]{0,60}\b(?:GH_TOKEN|GITHUB_TOKEN)\b/i,
];

/** gh の失敗文面が rate limit を示すか判定する。 */
export function looksLikeRateLimit(text: string): boolean {
  return (
    RATE_LIMIT_TEXT_PATTERNS.some((pattern) => pattern.test(text)) ||
    RATE_LIMIT_HTTP_429_PATTERN.test(text)
  );
}

/** gh の失敗文面が未ログイン・認証切れを示すか判定する。 */
export function looksLikeGhUnauthenticated(text: string): boolean {
  return GH_UNAUTHENTICATED_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}
