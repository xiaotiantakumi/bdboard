import type { CommandRunner } from '../../../application/ports/command-runner.js';
import type { WorktreeProvisionOutcome } from '../../../application/ports/worktree-provisioner.js';
import { runGit } from './git-command.js';

export type ResolveBaseRefResult =
  | { readonly baseRef: string; readonly baseRefFresh: boolean }
  | Extract<WorktreeProvisionOutcome, { ok: false }>;

export async function resolveBaseRef(
  commandRunner: CommandRunner,
  gitPath: string,
  repoRootPath: string,
  mainBranch: string,
  timeoutMs: number,
): Promise<ResolveBaseRefResult> {
  // 古い origin/<mainBranch> の追跡 ref のまま worktree を切らないよう先に fetch する。
  // オフライン等で fetch が失敗しても続行する — ローカルに残っている ref で provision できるべき。
  // mainBranch は検証コントラクト由来 (省略時 main)。master 系リポジトリで origin/main を
  // 決め打ちすると no-base-ref で必ず失敗する (bdboard-pkr6.18)。
  const baseRef = `origin/${mainBranch}`;
  const fetchResult = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['fetch', 'origin', mainBranch, '--quiet'],
    timeoutMs,
  );

  const resolved = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['rev-parse', '--verify', baseRef],
    timeoutMs,
  );

  if (resolved.exitCode === 0) {
    return {
      baseRef,
      baseRefFresh:
        fetchResult.exitCode === 0 && fetchResult.failureKind === undefined,
    };
  }

  return {
    ok: false,
    reason: 'no-base-ref',
    message: `${baseRef} could not be resolved`,
  };
}
