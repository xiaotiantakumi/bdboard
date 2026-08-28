import type { ReleaseSource } from '../../application/ports/release-source.js';
import type { LatestRelease } from '../../domain/update-check.js';

export interface GithubReleaseSourceOptions {
  /** `owner/repo`。 */
  readonly repository: string;
  /** 既定 3 秒。src/main.ts の bd バージョンチェック (3秒) に合わせている。 */
  readonly timeoutMs?: number;
  /** テスト用の差し替え口。既定は global fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** User-Agent に載せる自バージョン。GitHub API は UA 必須。 */
  readonly userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_USER_AGENT = 'bdboard';

function readLatestRelease(payload: unknown): LatestRelease | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const tag = record.tag_name;
  const url = record.html_url;
  if (typeof tag !== 'string' || tag.length === 0) {
    return null;
  }
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }

  // 返ってきた URL をそのまま UI のリンクにするので、GitHub の https 以外は捨てる。
  // API 応答が差し替わる想定は無いが、外部入力を検証せずに描画しないという原則
  // (bdboard-70z.7 レビュー観点) を守る。
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    return null;
  }

  return { tag, url };
}

/**
 * GitHub Releases API から最新リリースを1件取る (bdboard-70z.7)。
 *
 * 例外は投げず、取得できなければ null。bdboard はローカル完結のツールなので、
 * 外部サービスの都合で UI が壊れたり待たされたりしてはいけない。
 * 未認証 API のレート制限 (IP あたり 60 req/h) は呼び出し側のキャッシュで守る。
 */
export function createGithubReleaseSource(
  options: GithubReleaseSourceOptions,
): ReleaseSource {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const userAgent =
    options.userAgent === undefined ? DEFAULT_USER_AGENT : `${DEFAULT_USER_AGENT}/${options.userAgent}`;
  const url = `https://api.github.com/repos/${options.repository}/releases/latest`;

  return {
    async fetchLatest(): Promise<LatestRelease | null> {
      try {
        const response = await doFetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': userAgent,
          },
        });
        // 404 = リリースがまだ1本も無い、403/429 = レート制限。どれも「分からない」。
        if (!response.ok) {
          return null;
        }
        return readLatestRelease(await response.json());
      } catch {
        return null;
      }
    },
  };
}
