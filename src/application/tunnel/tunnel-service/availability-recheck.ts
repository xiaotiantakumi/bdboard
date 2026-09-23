/**
 * cloudflared が「使えない」と判定されたあと、再度 probe するまでの間隔。
 * 未インストールは後から解消しうるので恒久キャッシュにはできず、かといって
 * 毎リクエスト PATH を舐めるのも無駄なので TTL で妥協する (bdboard-syr)。
 */
export const TUNNEL_AVAILABILITY_RECHECK_MS = 30_000;
