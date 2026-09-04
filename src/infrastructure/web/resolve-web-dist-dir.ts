import path from 'node:path';

/** 環境変数から静的 Web UI の配信ディレクトリを決める。純粋関数(process.env を直接読まず引数で受ける) */
export function resolveWebDistDir(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env.BDBOARD_WEB_DIST;
  if (override !== undefined && override !== '') {
    return path.resolve(override);
  }
  return path.join(repoRoot, 'web', 'dist');
}
