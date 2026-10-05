import { existsSync } from 'node:fs';
import path from 'node:path';

/** repoRoot がメンテナ checkout (.beads を持つ) かを判定する。 */
export function isMaintainerEnvironment(repoRoot: string): boolean {
  return existsSync(path.join(repoRoot, '.beads'));
}
