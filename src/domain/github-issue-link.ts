/**
 * GitHub の issue と bd の external_ref を結ぶ純粋関数群 (bdboard-4y8q.9.2)。
 * `scripts/check-gh-issues.mjs` の判定を TypeScript へ移したもの。スクリプト本体は変えない。
 * 題名の無害化 (sanitizeTitle) と報告文の整形 (formatReport) は、端末向けなので移さない。
 */

// slug は gh の URL パス (repos/<slug>/issues) に埋まるので、`../` や `?` `#` `%` を通さない。
function isSafeSlugPart(part: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..';
}

/**
 * package.json の GitHub URL か `owner/repo` から API 用の slug を取り出す。`git@github.com:o/r`・
 * `https://github.com/o/r`・`o/r` を受け、`git+` 接頭辞と `.git` 接尾辞は除く。各部分は
 * `^[A-Za-z0-9_.-]+$` で、`.` と `..` だけの部分は不可 (スクリプトより厳しい)。
 */
export function parseRepoSlug(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('GitHub repository URL is missing');
  }
  const input = value.trim().replace(/^git\+/, '').replace(/\.git$/, '');
  const match =
    /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(input) ??
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i.exec(input) ??
    /^([^/\s]+)\/([^/\s]+)$/.exec(input);
  if (!match || !isSafeSlugPart(match[1]) || !isSafeSlugPart(match[2])) {
    throw new Error(`GitHub repository URL is invalid: ${value}`);
  }
  return `${match[1]}/${match[2]}`;
}

/**
 * external_ref のうち、このリポジトリの GitHub issue を指す番号を返す。受け付けるのは
 * `gh-<番号>` (大小文字無視) と `https://github.com/<owner>/<repo>/issues/<番号>` の 2 形式だけ。
 * それ以外の書き方は「未紐付け」側に倒れる (誤報はしても見逃しはしない)。
 */
export function linkedIssueNumbers(
  externalRefs: readonly string[],
  slug: string,
): ReadonlySet<number> {
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const issueUrl = new RegExp(`^https?://github\\.com/${escapedSlug}/issues/(\\d+)$`, 'i');
  const linked = new Set<number>();
  for (const ref of externalRefs) {
    const normalized = ref.trim();
    const number = /^gh-(\d+)$/i.exec(normalized)?.[1] ?? issueUrl.exec(normalized)?.[1];
    if (number !== undefined) {
      linked.add(Number(number));
    }
  }
  return linked;
}

/** bd の external_ref に紐付いていない issue だけを返す。 */
export function findUnlinkedIssues<T extends { readonly number: number }>(
  issues: readonly T[],
  linkedNumbers: ReadonlySet<number>,
): T[] {
  return issues.filter((issue) => !linkedNumbers.has(issue.number));
}

/**
 * GitHub の issues API は PR も返す。`pullRequest: true` の行を除く (残りの行はそのまま)。
 */
export function excludePullRequests<T extends { readonly pullRequest: boolean }>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => !row.pullRequest);
}
