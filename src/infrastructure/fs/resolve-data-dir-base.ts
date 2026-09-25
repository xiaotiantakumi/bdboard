import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * サーバーが書き込むデータ (添付画像、bdboard-4y8q.1 の不具合報告下書きなど) の
 * 置き場の基点を決める。process.env は直接読まない (isLinkedWorktreeCheckout()
 * と同じ流儀で、repoRoot/.git の有無だけを fs 経由で判定する — 完全な副作用フリー
 * ではない点に注意)。
 *
 * repoRoot/.git が存在すれば (ディレクトリ = 通常の git clone、ファイル = linked
 * worktree のどちらでも) git の作業ツリーとみなし、<repoRoot>/data を基点にする
 * (clone / worktree の既存動作を変えない。祖先ディレクトリは辿らない —
 * repoRoot 自身の直下だけを見る)。
 * 存在しなければ npm/npx でインストールされた環境 (repoRoot がパッケージの置き場に
 * なり、更新のたびに置き換えられうる) とみなし、ホームの下の ~/.bdboard を基点に
 * する (キャッシュ DB ~/.bdboard/cache.db と同じ決め方。プラットフォーム分岐は無い。
 * bootstrap/resolve-main-config.ts の resolveDbPath 参照)。
 *
 * bdboard-727y
 */
export function resolveDataDirBase(repoRoot: string): string {
  if (fs.existsSync(path.join(repoRoot, '.git'))) {
    return path.join(repoRoot, 'data');
  }
  return path.join(os.homedir(), '.bdboard');
}
