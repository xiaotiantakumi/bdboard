import fs from 'node:fs';
import path from 'node:path';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import type {
  WorktreeProvisionOutcome,
  WorktreeProvisionRequest,
  WorktreeProvisioner,
} from '../../application/ports/worktree-provisioner.js';
import { BD_BRANCH_PREFIX } from '../../domain/git-worktree.js';
import { isTicketId } from '../../domain/ticket-id.js';

const DEFAULT_GIT_PATH = 'git';
const DEFAULT_TIMEOUT_MS = 30_000;
const WORKTREES_DIR = '.claude/worktrees';

/** Stable affixes for worktree-branch-mismatch messages (Web UI extracts branch names from these). */
export const WORKTREE_BRANCH_MISMATCH_ON_BRANCH = ': on branch ';
export const WORKTREE_BRANCH_MISMATCH_EXPECTED = ', expected ';

export function formatWorktreeBranchMismatchMessage(
  worktreePath: string,
  actualBranch: string,
  expectedBranch: string,
): string {
  return `${worktreePath}${WORKTREE_BRANCH_MISMATCH_ON_BRANCH}${actualBranch}${WORKTREE_BRANCH_MISMATCH_EXPECTED}${expectedBranch}`;
}

export interface GitWorktreeProvisionerOptions {
  readonly commandRunner: CommandRunner;
  readonly gitPath?: string;
  readonly timeoutMs?: number;
}

function runGit(
  commandRunner: CommandRunner,
  gitPath: string,
  rootPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return commandRunner.run(gitPath, ['-C', rootPath, ...args], { timeoutMs });
}

function parseWorktreePaths(output: string): readonly string[] {
  const paths: string[] = [];

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length));
    }
  }

  return paths;
}

/** Normalize paths for comparison (e.g. /tmp vs /private/tmp on macOS). */
export function normalizePathForComparison(pathValue: string): string {
  try {
    return fs.realpathSync.native(pathValue);
  } catch {
    return pathValue;
  }
}

function findExistingWorktreePath(
  existingPaths: readonly string[],
  worktreePath: string,
): string | undefined {
  const normalizedTarget = normalizePathForComparison(worktreePath);

  for (const candidate of existingPaths) {
    if (normalizePathForComparison(candidate) === normalizedTarget) {
      return candidate;
    }
  }

  return undefined;
}

function validateTicketIdForWorktree(ticketId: string): boolean {
  if (!isTicketId(ticketId)) {
    return false;
  }

  if (ticketId.includes('/') || ticketId.includes('\\') || ticketId.includes('..')) {
    return false;
  }

  // CommandRunner はシェルを介さないが、先頭 `-` は git のオプション解釈に紛れうる形、
  // 先頭 `.` は隠しディレクトリ/相対パス的な形なので意図を明確にするため弾く。
  if (ticketId.startsWith('-') || ticketId.startsWith('.')) {
    return false;
  }

  return true;
}

function buildPaths(repoRootPath: string, ticketId: string): {
  worktreePath: string;
  branchName: string;
} {
  const worktreePath = path.join(repoRootPath, WORKTREES_DIR, ticketId);
  const branchName = `${BD_BRANCH_PREFIX}${ticketId}`;

  return { worktreePath, branchName };
}

async function resolveBaseRef(
  commandRunner: CommandRunner,
  gitPath: string,
  repoRootPath: string,
  timeoutMs: number,
): Promise<WorktreeProvisionOutcome | { readonly baseRef: string }> {
  // 古い origin/main の追跡 ref のまま worktree を切らないよう先に fetch する。
  // オフライン等で fetch が失敗しても続行する — ローカルに残っている ref で provision できるべき。
  await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['fetch', 'origin', 'main', '--quiet'],
    timeoutMs,
  );

  const originMain = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['rev-parse', '--verify', 'origin/main'],
    timeoutMs,
  );

  if (originMain.exitCode === 0) {
    return { baseRef: 'origin/main' };
  }

  return {
    ok: false,
    reason: 'no-base-ref',
    message: 'origin/main could not be resolved',
  };
}

export function createGitWorktreeProvisioner(
  options: GitWorktreeProvisionerOptions,
): WorktreeProvisioner {
  const commandRunner = options.commandRunner;
  const gitPath = options.gitPath ?? DEFAULT_GIT_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async provision(req: WorktreeProvisionRequest): Promise<WorktreeProvisionOutcome> {
      const { repoRootPath, ticketId } = req;

      if (!validateTicketIdForWorktree(ticketId)) {
        return { ok: false, reason: 'invalid-ticket-id' };
      }

      const { worktreePath, branchName } = buildPaths(repoRootPath, ticketId);

      const listResult = await runGit(
        commandRunner,
        gitPath,
        repoRootPath,
        ['worktree', 'list', '--porcelain'],
        timeoutMs,
      );

      if (listResult.exitCode !== 0) {
        return {
          ok: false,
          reason: 'git-failed',
          message: listResult.stderr || 'git worktree list failed',
        };
      }

      const existingPaths = parseWorktreePaths(listResult.stdout);
      const existingWorktreePath = findExistingWorktreePath(existingPaths, worktreePath);
      if (existingWorktreePath !== undefined) {
        const statusResult = await runGit(
          commandRunner,
          gitPath,
          existingWorktreePath,
          ['status', '--porcelain'],
          timeoutMs,
        );

        if (statusResult.exitCode !== 0) {
          return {
            ok: false,
            reason: 'git-failed',
            message: statusResult.stderr || 'git status failed',
          };
        }

        if (statusResult.stdout.trim() !== '') {
          return {
            ok: false,
            reason: 'worktree-dirty',
            message: `${existingWorktreePath}: uncommitted changes prevent agent run`,
          };
        }

        // `.claude/worktrees/<ticket-id>` は CLAUDE.md の人間用 worktree と同じパス。
        // 人間が checkout main したり別ブランチで作業した worktree をそのまま再利用すると、
        // エージェントは想定外のブランチ上で編集を始める。API/UI は計算値 bd/<ticketId> を
        // 表示するだけなので、実 HEAD のブランチ名を検証しないと運用者が気づけない。
        const headBranchResult = await runGit(
          commandRunner,
          gitPath,
          existingWorktreePath,
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          timeoutMs,
        );

        if (headBranchResult.exitCode !== 0) {
          return {
            ok: false,
            reason: 'git-failed',
            message: headBranchResult.stderr || 'git rev-parse failed',
          };
        }

        const actualBranch = headBranchResult.stdout.trim();
        if (actualBranch !== branchName) {
          return {
            ok: false,
            reason: 'worktree-branch-mismatch',
            message: formatWorktreeBranchMismatchMessage(
              existingWorktreePath,
              actualBranch,
              branchName,
            ),
          };
        }

        return {
          ok: true,
          worktreePath: existingWorktreePath,
          // 再利用成功時は計算値ではなく rev-parse の実測値を正とする（一致しているが検証済み）。
          branchName: actualBranch,
          reused: true,
        };
      }

      const baseRefResult = await resolveBaseRef(
        commandRunner,
        gitPath,
        repoRootPath,
        timeoutMs,
      );

      if ('ok' in baseRefResult && baseRefResult.ok === false) {
        return baseRefResult;
      }

      const baseRef = (baseRefResult as { readonly baseRef: string }).baseRef;

      const createWithBranch = await runGit(
        commandRunner,
        gitPath,
        repoRootPath,
        ['worktree', 'add', '-b', branchName, worktreePath, baseRef],
        timeoutMs,
      );

      if (createWithBranch.exitCode === 0) {
        return {
          ok: true,
          worktreePath,
          branchName,
          reused: false,
        };
      }

      const createExistingBranch = await runGit(
        commandRunner,
        gitPath,
        repoRootPath,
        ['worktree', 'add', worktreePath, branchName],
        timeoutMs,
      );

      if (createExistingBranch.exitCode === 0) {
        return {
          ok: true,
          worktreePath,
          branchName,
          reused: false,
        };
      }

      return {
        ok: false,
        reason: 'git-failed',
        message:
          createExistingBranch.stderr ||
          createWithBranch.stderr ||
          'git worktree add failed',
      };
    },
  };
}
