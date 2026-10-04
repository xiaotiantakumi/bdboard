import path from 'node:path';
import { resolveDataDirBase } from './resolve-data-dir-base.js';

/**
 * 不具合報告の下書き (bdboard-4y8q.1、docs/ISSUE-REPORTING.md 2節) の保存先ディレクトリを
 * 決める。純粋関数 (process.env を直接読まず引数で受ける)。resolveAttachmentsDir と同じ形。
 *
 * 既定は resolveDataDirBase(repoRoot) が返す基点の下の "issue-drafts"。git の作業ツリーなら
 * <repoRoot>/data/issue-drafts (gitignore 済み)、npm/npx インストール環境なら
 * ~/.bdboard/issue-drafts (添付画像の "attachments" の隣。bdboard-727y と同じ理由で、
 * パッケージの置き場に置くと更新で消える)。キャッシュ DB (~/.bdboard/cache.db) の中には置かない。
 * BDBOARD_ISSUE_DRAFTS_DIR が空でなければそれを優先する。
 */
export function resolveIssueDraftsDir(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env.BDBOARD_ISSUE_DRAFTS_DIR;
  if (override !== undefined && override !== '') {
    return path.resolve(override);
  }
  return path.join(resolveDataDirBase(repoRoot), 'issue-drafts');
}
