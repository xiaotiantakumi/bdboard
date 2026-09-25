import path from 'node:path';
import { resolveDataDirBase } from './resolve-data-dir-base.js';

/**
 * チケット添付画像 (bdboard-qw26) の保存先ディレクトリを決める。純粋関数
 * (process.env を直接読まず引数で受ける)。
 *
 * 既定は resolveDataDirBase(repoRoot) が返す基点の下の "attachments"。
 * git の作業ツリー (clone / linked worktree) なら <repoRoot>/data/attachments
 * (gitignore 済み。挙動変更ゼロ)、npm/npx インストール環境 (.git が無い) なら
 * ~/.bdboard/attachments (bdboard-727y: 旧既定だと repoRoot がパッケージの
 * 置き場になり、更新のたびに添付画像が消えるおそれがあった)。
 */
export function resolveAttachmentsDir(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env.BDBOARD_ATTACHMENTS_DIR;
  if (override !== undefined && override !== '') {
    return path.resolve(override);
  }
  return path.join(resolveDataDirBase(repoRoot), 'attachments');
}
