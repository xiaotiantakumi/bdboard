import fs from 'node:fs';
import path from 'node:path';
import { PACK_HOOKS_DIR } from '../../../domain/harness-hooks.js';
import {
  resolveUnderClaudeDir,
  skillInstallRelativePath,
} from '../../../domain/harness-path.js';
import { HarnessPathTraversalError } from '../../../application/ports/harness-injector.js';

/** hook スクリプトとして実行ビットを立てる対象か (pack 根からの相対パス)。 */
export function isHookScript(packFileRelative: string): boolean {
  return (
    packFileRelative.startsWith(`${PACK_HOOKS_DIR}/`) && packFileRelative.endsWith('.sh')
  );
}

export async function copyPackFile(
  projectRootPath: string,
  packsRoot: string,
  packName: string,
  packFileRelative: string,
): Promise<string> {
  const destinationRelative = skillInstallRelativePath(packName, packFileRelative);
  if (destinationRelative === null) {
    throw new HarnessPathTraversalError(
      `unsafe pack file path: ${packName}/${packFileRelative}`,
    );
  }

  const destinationAbsolute = resolveUnderClaudeDir(projectRootPath, destinationRelative);
  if (destinationAbsolute === null) {
    throw new HarnessPathTraversalError(
      `destination escapes .claude/: ${destinationRelative}`,
    );
  }

  const sourceAbsolute = path.join(packsRoot, packName, packFileRelative);
  const sourceResolved = path.resolve(sourceAbsolute);
  const packRootResolved = path.resolve(packsRoot, packName);
  const relativeToPack = path.relative(packRootResolved, sourceResolved);
  if (relativeToPack.startsWith('..') || path.isAbsolute(relativeToPack)) {
    throw new HarnessPathTraversalError(`unsafe pack source path: ${packFileRelative}`);
  }

  await fs.promises.mkdir(path.dirname(destinationAbsolute), { recursive: true });
  await fs.promises.copyFile(sourceResolved, destinationAbsolute);

  // hook は Claude Code が `bash <script>` ではなく登録したコマンド経由で叩く。
  // ここでは `bash "..."` を書き込むので実行ビットが無くても動くが、人が直接
  // 叩けないと調査時に詰まるので立てておく。copyFile は既存ファイルの mode を
  // 引き継ぐため、上書き再注入でも毎回やる必要がある。win32 では意味が無い。
  if (process.platform !== 'win32' && isHookScript(packFileRelative)) {
    await fs.promises.chmod(destinationAbsolute, 0o755);
  }

  return destinationRelative;
}

export async function removeStaleFile(
  projectRootPath: string,
  projectRelativePath: string,
): Promise<void> {
  const absolute = resolveUnderClaudeDir(projectRootPath, projectRelativePath);
  if (absolute === null) {
    throw new HarnessPathTraversalError(
      `stale removal blocked outside .claude/: ${projectRelativePath}`,
    );
  }

  try {
    await fs.promises.unlink(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}
