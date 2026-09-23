import type { ScannerDeps } from './deps.js';
import { runGitReadOnly } from './git-command.js';

/**
 * merge-base の相手にする ref の候補。先に成功したものを使う。
 *
 * `npm run drift` (scripts/check-drift.mjs) は origin/main 決め打ちだが、こちらは
 * 注入先プロジェクトの worktree も見るので master / origin 無しにも耐えさせる。
 * ここでは **fetch しない**: 他セッションの worktree に対してネットワーク操作を
 * 走らせるのは読み取り専用の約束から外れるうえ、盤面の更新周期で毎回叩くには重い。
 * 手元の origin/main が数時間古いぶんの取りこぼしは許容する (着手中同士の重複は
 * どのみち merge-base より後ろのコミットで起きる)。
 */
export const MERGE_BASE_CANDIDATE_REFS: readonly string[] = [
  'origin/main',
  'origin/master',
  'main',
  'master',
];

export async function readHeadSha(deps: ScannerDeps, worktreePath: string): Promise<string> {
  const { commandRunner, gitPath, timeoutMs } = deps;
  const result = await runGitReadOnly(
    commandRunner,
    gitPath,
    worktreePath,
    ['rev-parse', 'HEAD'],
    timeoutMs,
  );
  const headSha = result.stdout.trim();
  if (result.exitCode !== 0 || headSha.length === 0) {
    throw new Error(
      `git rev-parse failed in ${worktreePath} (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return headSha;
}

export async function resolveMergeBase(deps: ScannerDeps, worktreePath: string): Promise<string> {
  const { commandRunner, gitPath, timeoutMs } = deps;
  for (const ref of MERGE_BASE_CANDIDATE_REFS) {
    const result = await runGitReadOnly(
      commandRunner,
      gitPath,
      worktreePath,
      ['merge-base', ref, 'HEAD'],
      timeoutMs,
    );
    const base = result.stdout.trim();
    if (result.exitCode === 0 && base.length > 0) {
      return base;
    }
  }

  throw new Error(
    `no merge-base against ${MERGE_BASE_CANDIDATE_REFS.join(' / ')} in ${worktreePath}`,
  );
}
