import path from 'node:path';
import { resolveDataDirBase } from './resolve-data-dir-base.js';

/**
 * 届いた issue の写し (bdboard-4y8q.9.3、docs/ISSUE-REPORTING.md 8節) の保存先ディレクトリ。
 * resolveDataDirBase(repoRoot) が返す基点の下の "external-issues" (git の作業ツリーなら
 * <repoRoot>/data/external-issues、npm/npx インストール環境なら ~/.bdboard/external-issues)。
 * 下書き (resolveIssueDraftsDir) と違い、環境変数での差し替えは用意しない (配線は 4y8q.9.4)。
 */
export function resolveExternalIssuesDir(repoRoot: string): string {
  return path.join(resolveDataDirBase(repoRoot), 'external-issues');
}
