import fs from 'node:fs';
import path from 'node:path';
import { resolveUnderClaudeDir } from '../../../domain/harness-path.js';
import { HarnessPathTraversalError } from '../../../application/ports/harness-injector.js';
import type { UninjectPlan } from './uninject-pack.js';
import { findSymlinkOnPath } from './uninject-safety.js';

async function unlinkIfPresent(absolute: string): Promise<void> {
  try {
    await fs.promises.unlink(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/** 削除したパスの親を `.claude/` まで辿り、**空のディレクトリだけ**を深い順に畳む。 */
async function pruneEmptyDirectories(
  projectRootPath: string,
  removedAbsolutePaths: readonly string[],
): Promise<void> {
  const claudeRoot = path.resolve(projectRootPath, '.claude');
  const candidates = new Set<string>();
  for (const removed of removedAbsolutePaths) {
    let current = path.dirname(removed);
    while (current.startsWith(`${claudeRoot}${path.sep}`) || current === claudeRoot) {
      candidates.add(current);
      if (current === claudeRoot) {
        break;
      }
      current = path.dirname(current);
    }
  }

  const deepestFirst = [...candidates].sort((a, b) => b.length - a.length);
  for (const directory of deepestFirst) {
    try {
      // シンボリックリンクは辿らない (リンクそのものも消さない)。
      if ((await fs.promises.lstat(directory)).isSymbolicLink()) {
        continue;
      }
      // rmdir は空でなければ失敗する。他人のファイルが残るディレクトリは消えない。
      await fs.promises.rmdir(directory);
    } catch {
      // 空でない・既に無い。どちらも無害。
    }
  }
}

/**
 * 計画を実行する (`planUninject` の続き)。順序は**注入記録を最後に書き換える**: 途中で失敗しても
 * 注入記録にパックが残るので、同じコマンドをもう一度実行すれば続きから終えられる
 * (各操作は「既に無い」を許す)。
 */
export async function applyUninject(plan: UninjectPlan): Promise<void> {
  // 空ディレクトリを畳む起点。既に消えていたファイルも含める (再実行で残骸を片付けるため)。
  const removedPaths: string[] = [];

  for (const { write } of plan.settings) {
    if (write.content === null) {
      await unlinkIfPresent(write.absolute);
      removedPaths.push(write.absolute);
    } else {
      await fs.promises.writeFile(write.absolute, write.content, 'utf8');
    }
  }

  for (const { relativePath } of plan.files) {
    const absolute = resolveUnderClaudeDir(plan.projectRootPath, relativePath);
    if (absolute === null) {
      throw new HarnessPathTraversalError(`removal blocked outside .claude/: ${relativePath}`);
    }
    // 計画の後でリンクに替えられた場合に備えて、消す直前にもう一度見る。
    const link = await findSymlinkOnPath(plan.projectRootPath, path.posix.dirname(relativePath));
    if (link !== null) {
      throw new HarnessPathTraversalError(`removal blocked: ${link} is a symbolic link`);
    }
    await unlinkIfPresent(absolute);
    removedPaths.push(absolute);
  }

  if (plan.gitignore !== null) {
    await fs.promises.writeFile(plan.gitignore.absolute, plan.gitignore.content, 'utf8');
  }

  if (plan.manifest.content === null) {
    await unlinkIfPresent(plan.manifest.absolute);
    removedPaths.push(plan.manifest.absolute);
  } else {
    await fs.promises.writeFile(plan.manifest.absolute, plan.manifest.content, 'utf8');
  }

  await pruneEmptyDirectories(plan.projectRootPath, removedPaths);
}
