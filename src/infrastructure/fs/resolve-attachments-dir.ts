import path from 'node:path';

/**
 * チケット添付画像 (bdboard-qw26) の保存先ディレクトリを決める。
 * resolve-web-dist-dir.ts と同じ形: 純粋関数 (process.env を直接読まず引数で受ける)。
 *
 * 既定は "<repoRoot>/data/attachments" (gitignore 済み)。repoRoot は main.ts が
 * import.meta.url から算出する、サーバープロセス自身が置かれているディレクトリ
 * (= 常に main checkout。worktree でサーバーが動くことは無い) なので、
 * どのプロジェクトのチケットを扱っていても保存先は1箇所に集約される。
 */
export function resolveAttachmentsDir(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env.BDBOARD_ATTACHMENTS_DIR;
  if (override !== undefined && override !== '') {
    return path.resolve(override);
  }
  return path.join(repoRoot, 'data', 'attachments');
}
