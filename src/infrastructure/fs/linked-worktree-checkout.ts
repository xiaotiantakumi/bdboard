import fs from 'node:fs';
import path from 'node:path';

/**
 * repoRoot/.git がファイルなら linked checkout。未管理パスや main checkout は false。
 *
 * bdboard-6h6n: これはヒューリスティックで、git submodule や `--separate-git-dir` で作った
 * clone、bare repo + worktree 構成でも .git はファイルになるため true を返す(false positive)。
 * 安全側(false positive でも「明示 BDBOARD_DB を求める」方向に倒れるだけ)なので判定はそのまま
 * 残すが、呼び出し側のエラー文言(resolve-main-config.ts の MainCheckoutDbPathRequiredError)は
 * 「linked worktree」と断定しない言い回しにしてある。
 */
export function isLinkedWorktreeCheckout(repoRoot: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path.join(repoRoot, '.git'));
  } catch {
    return false;
  }
  return stat.isFile();
}
