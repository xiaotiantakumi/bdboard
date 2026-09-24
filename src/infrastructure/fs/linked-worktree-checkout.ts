import fs from 'node:fs';
import path from 'node:path';

/** repoRoot/.git がファイルなら linked checkout。未管理パスや main checkout は false。 */
export function isLinkedWorktreeCheckout(repoRoot: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path.join(repoRoot, '.git'));
  } catch {
    return false;
  }
  return stat.isFile();
}
