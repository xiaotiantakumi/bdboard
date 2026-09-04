import fs from 'node:fs';
import path from 'node:path';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import type {
  WorktreeProvisionOutcome,
  WorktreeProvisionRequest,
  WorktreeProvisioner,
} from '../../application/ports/worktree-provisioner.js';
import { BD_BRANCH_PREFIX, WORKTREES_DIR } from '../../domain/git-worktree.js';
import { isTicketId } from '../../domain/ticket-id.js';

const DEFAULT_GIT_PATH = 'git';
const DEFAULT_GH_PATH = 'gh';
const DEFAULT_LSOF_PATH = 'lsof';
const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_MANAGED_WORKTREES = 20;

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
  readonly ghPath?: string;
  readonly lsofPath?: string;
  readonly timeoutMs?: number;
  readonly maxManagedWorktrees?: number;
  readonly logWarn?: (message: string) => void;
}

interface WorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
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

function parseWorktreeEntries(output: string): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];

  for (const block of output.split(/\n\s*\n/)) {
    let worktreePath: string | undefined;
    let branch: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length);
      }
    }
    if (worktreePath !== undefined) {
      entries.push({ path: worktreePath, branch });
    }
  }

  return entries;
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

/**
 * ticket id は worktree パス・ブランチ名だけでなく、claude CLI の
 * `Edit(//<worktree>/**)` パーミッションルールへ無エスケープで補間される
 * (claude-runner.ts の buildWorktreeEditTool)。')' を含む id はルールの形を変え、
 * '**' を含む id は他チケットの worktree にマッチしうる。denylist では
 * 「まだ気づいていないメタ文字」を取りこぼすので allowlist で通す (bdboard-54be.1 M-5)。
 */
const TICKET_ID_FOR_WORKTREE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateTicketIdForWorktree(ticketId: string): boolean {
  if (!isTicketId(ticketId)) {
    return false;
  }

  if (ticketId.includes('..')) {
    return false;
  }

  return TICKET_ID_FOR_WORKTREE.test(ticketId);
}

function buildPaths(repoRootPath: string, ticketId: string): {
  worktreePath: string;
  branchName: string;
} {
  const worktreePath = path.join(repoRootPath, WORKTREES_DIR, ticketId);
  const branchName = `${BD_BRANCH_PREFIX}${ticketId}`;

  return { worktreePath, branchName };
}

function managedTicketId(repoRootPath: string, worktreePath: string): string | undefined {
  const managedRoot = normalizePathForComparison(path.join(repoRootPath, WORKTREES_DIR));
  const normalizedPath = normalizePathForComparison(worktreePath);
  if (path.dirname(normalizedPath) !== managedRoot) {
    return undefined;
  }

  const ticketId = path.basename(normalizedPath);
  return validateTicketIdForWorktree(ticketId) ? ticketId : undefined;
}

type WorktreeUseStatus = 'idle' | 'busy' | 'unknown';

async function inspectWorktreeUse(
  commandRunner: CommandRunner,
  lsofPath: string,
  worktreePath: string,
  timeoutMs: number,
): Promise<WorktreeUseStatus> {
  const result = await commandRunner.run(
    lsofPath,
    ['-a', '-d', 'cwd', '+D', worktreePath],
    { timeoutMs },
  );

  // Some lsof builds return 1 even after printing matches. Output is the
  // authoritative signal: any listed process makes the worktree busy.
  if (result.stdout.trim() !== '') {
    return 'busy';
  }

  if (
    result.exitCode === 0
    && result.failureKind === undefined
    && result.stderr.trim() === ''
  ) {
    return 'idle';
  }

  // lsof uses exit 1 with no output when the selection matched no processes.
  // Spawn failures, timeouts, diagnostics, and every other non-zero result are
  // intentionally unknown so cleanup fails closed.
  if (
    result.exitCode === 1
    && result.failureKind === undefined
    && result.stderr.trim() === ''
  ) {
    return 'idle';
  }

  return 'unknown';
}

interface CleanupMergedOptions {
  readonly commandRunner: CommandRunner;
  readonly gitPath: string;
  readonly ghPath: string;
  readonly lsofPath: string;
  readonly repoRootPath: string;
  readonly worktreeListOutput: string;
  /**
   * Closed tickets eligible for destructive cleanup. Always a set by the time
   * it reaches here: the request-level `undefined` is normalised to an empty
   * set at the call site, so "no filter supplied" means "nothing is eligible"
   * rather than "everything is eligible" (bdboard-54be.3).
   */
  readonly cleanupEligibleTicketIds: ReadonlySet<string>;
  readonly isTicketProtected: (ticketId: string) => boolean;
  readonly timeoutMs: number;
  readonly logWarn: (message: string) => void;
}

type CleanupMergedResult =
  | {
      readonly ok: true;
      /** Number of ticket ids retaining a managed worktree, branch, or both. */
      readonly remainingManagedArtifacts: number;
      readonly retainedTicketIds: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly message: string };

type BranchMergeEvidence =
  | { readonly kind: 'ancestor' }
  | { readonly kind: 'merged-pr'; readonly verifiedHeadOid: string };

async function isBranchMerged(
  commandRunner: CommandRunner,
  gitPath: string,
  ghPath: string,
  repoRootPath: string,
  branchName: string,
  timeoutMs: number,
): Promise<BranchMergeEvidence | null> {
  const fullBranchRef = `refs/heads/${branchName}`;
  const ancestor = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['merge-base', '--is-ancestor', fullBranchRef, 'origin/main'],
    timeoutMs,
  );
  if (ancestor.exitCode === 0) {
    return { kind: 'ancestor' };
  }

  // This repository requires squash merges, so the branch tip is normally not
  // an ancestor of origin/main. A merged PR is sufficient only when its recorded
  // head oid still equals the local branch tip; a reused branch with newer,
  // unmerged commits must not be mistaken for the older merged PR.
  const localHead = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['rev-parse', '--verify', fullBranchRef],
    timeoutMs,
  );
  if (localHead.exitCode !== 0 || localHead.stdout.trim() === '') {
    return null;
  }

  const mergedPrs = await commandRunner.run(
    ghPath,
    [
      'pr',
      'list',
      '--head',
      branchName,
      '--state',
      'merged',
      '--limit',
      '100',
      '--json',
      'baseRefName,headRefOid,mergeCommit',
    ],
    { cwd: repoRootPath, timeoutMs },
  );
  if (mergedPrs.exitCode !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(mergedPrs.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const expectedHead = localHead.stdout.trim();
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }
      const candidate = item as {
        readonly baseRefName?: unknown;
        readonly headRefOid?: unknown;
        readonly mergeCommit?: { readonly oid?: unknown } | null;
      };
      if (
        candidate.baseRefName !== 'main'
        || candidate.headRefOid !== expectedHead
        || typeof candidate.mergeCommit?.oid !== 'string'
      ) {
        continue;
      }
      const mergeLanded = await runGit(
        commandRunner,
        gitPath,
        repoRootPath,
        ['merge-base', '--is-ancestor', candidate.mergeCommit.oid, 'origin/main'],
        timeoutMs,
      );
      if (mergeLanded.exitCode === 0) {
        return { kind: 'merged-pr', verifiedHeadOid: expectedHead };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function cleanupMergedManagedArtifacts(
  options: CleanupMergedOptions,
): Promise<CleanupMergedResult> {
  // Run completion is not a cleanup boundary. A successful agent leaves
  // uncommitted edits for a human to verify and turn into a PR, while a failed
  // run may leave evidence needed for diagnosis. Cleanup is therefore
  // opportunistic, immediately before another managed worktree would be added,
  // and limited to artifacts already merged into origin/main.
  const {
    commandRunner,
    gitPath,
    ghPath,
    lsofPath,
    repoRootPath,
    worktreeListOutput,
    cleanupEligibleTicketIds,
    isTicketProtected,
    timeoutMs,
    logWarn,
  } = options;
  const entries = parseWorktreeEntries(worktreeListOutput);
  const checkedOutBranches = new Set(
    entries.flatMap((entry) => (entry.branch === null ? [] : [entry.branch])),
  );
  const retainedTicketIds = new Set<string>();

  for (const entry of entries) {
    const ticketId = managedTicketId(repoRootPath, entry.path);
    if (ticketId === undefined) {
      continue;
    }

    retainedTicketIds.add(ticketId);
    if (
      entry.branch !== `${BD_BRANCH_PREFIX}${ticketId}`
      || !cleanupEligibleTicketIds.has(ticketId)
      || isTicketProtected(ticketId)
    ) {
      continue;
    }

    const status = await runGit(
      commandRunner,
      gitPath,
      entry.path,
      ['status', '--porcelain'],
      timeoutMs,
    );
    if (status.exitCode !== 0 || status.stdout.trim() !== '') {
      continue;
    }

    const mergeEvidence = await isBranchMerged(
      commandRunner,
      gitPath,
      ghPath,
      repoRootPath,
      entry.branch,
      timeoutMs,
    );
    if (mergeEvidence === null) {
      continue;
    }

    const useStatus = await inspectWorktreeUse(
      commandRunner,
      lsofPath,
      entry.path,
      timeoutMs,
    );
    if (useStatus !== 'idle') {
      if (useStatus === 'unknown') {
        logWarn(
          `[agent-run cleanup] lsof failed for ${entry.path}; leaving it untouched`,
        );
      }
      continue;
    }

    // A run can start while git/lsof commands above are awaited. Re-read the
    // active-run state at the destructive boundary instead of trusting a
    // request-start snapshot.
    if (isTicketProtected(ticketId)) {
      continue;
    }

    const remove = await runGit(
      commandRunner,
      gitPath,
      repoRootPath,
      ['worktree', 'remove', entry.path],
      timeoutMs,
    );
    if (remove.exitCode !== 0) {
      logWarn(
        `[agent-run cleanup] could not remove worktree ${entry.path}: ${remove.stderr || 'git worktree remove failed'}`,
      );
      continue;
    }

    checkedOutBranches.delete(entry.branch);
    const deleteBranch = mergeEvidence.kind === 'ancestor'
      ? await runGit(
        commandRunner,
        gitPath,
        repoRootPath,
        ['branch', '-d', entry.branch],
        timeoutMs,
      )
      : await runGit(
        commandRunner,
        gitPath,
        repoRootPath,
        [
          'update-ref',
          '-d',
          `refs/heads/${entry.branch}`,
          mergeEvidence.verifiedHeadOid,
        ],
        timeoutMs,
      );
    if (deleteBranch.exitCode !== 0) {
      logWarn(
        `[agent-run cleanup] removed worktree but could not delete branch ${entry.branch}: ${deleteBranch.stderr || 'git branch -d failed'}`,
      );
    } else {
      retainedTicketIds.delete(ticketId);
    }
  }

  // Recover branch-only leftovers from a prior partial cleanup. Never touch a
  // branch still checked out anywhere. Direct ancestors use branch -d as a
  // second merged guard; squash-merged branches use update-ref's old-OID CAS so
  // a branch that advances after the GitHub proof is collected is preserved.
  const branchList = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['for-each-ref', '--format=%(refname:short)', `refs/heads/${BD_BRANCH_PREFIX}`],
    timeoutMs,
  );
  if (branchList.exitCode !== 0) {
    return {
      ok: false,
      message: branchList.stderr || 'git branch list failed',
    };
  }

  for (const branchName of branchList.stdout.split('\n').filter(Boolean)) {
      if (!branchName.startsWith(BD_BRANCH_PREFIX) || checkedOutBranches.has(branchName)) {
        continue;
      }
      const ticketId = branchName.slice(BD_BRANCH_PREFIX.length);
      if (!validateTicketIdForWorktree(ticketId)) {
        continue;
      }
      retainedTicketIds.add(ticketId);
      if (
        !cleanupEligibleTicketIds.has(ticketId)
        || isTicketProtected(ticketId)
      ) {
        continue;
      }
      const mergeEvidence = await isBranchMerged(
        commandRunner,
        gitPath,
        ghPath,
        repoRootPath,
        branchName,
        timeoutMs,
      );
      if (mergeEvidence === null) {
        continue;
      }
      if (isTicketProtected(ticketId)) {
        continue;
      }
      const deleteBranch = mergeEvidence.kind === 'ancestor'
        ? await runGit(
          commandRunner,
          gitPath,
          repoRootPath,
          ['branch', '-d', branchName],
          timeoutMs,
        )
        : await runGit(
          commandRunner,
          gitPath,
          repoRootPath,
          [
            'update-ref',
            '-d',
            `refs/heads/${branchName}`,
            mergeEvidence.verifiedHeadOid,
          ],
          timeoutMs,
        );
      if (deleteBranch.exitCode !== 0) {
        logWarn(
          `[agent-run cleanup] could not delete merged branch ${branchName}: ${deleteBranch.stderr || 'git branch -d failed'}`,
        );
      } else {
        retainedTicketIds.delete(ticketId);
      }
  }

  return {
    ok: true,
    remainingManagedArtifacts: retainedTicketIds.size,
    retainedTicketIds,
  };
}

type ResolveBaseRefResult =
  | { readonly baseRef: string; readonly originMainFresh: boolean }
  | Extract<WorktreeProvisionOutcome, { ok: false }>;

async function resolveBaseRef(
  commandRunner: CommandRunner,
  gitPath: string,
  repoRootPath: string,
  timeoutMs: number,
): Promise<ResolveBaseRefResult> {
  // 古い origin/main の追跡 ref のまま worktree を切らないよう先に fetch する。
  // オフライン等で fetch が失敗しても続行する — ローカルに残っている ref で provision できるべき。
  const fetchResult = await runGit(
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
    return {
      baseRef: 'origin/main',
      originMainFresh:
        fetchResult.exitCode === 0 && fetchResult.failureKind === undefined,
    };
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
  const ghPath = options.ghPath ?? DEFAULT_GH_PATH;
  const lsofPath = options.lsofPath ?? DEFAULT_LSOF_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxManagedWorktrees = Math.max(
    1,
    Math.floor(options.maxManagedWorktrees ?? DEFAULT_MAX_MANAGED_WORKTREES),
  );
  const logWarn = options.logWarn ?? ((message: string) => console.warn(message));
  const provisionUnlocked = async (
    req: WorktreeProvisionRequest,
  ): Promise<WorktreeProvisionOutcome> => {
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

      if ('ok' in baseRefResult) {
        return baseRefResult;
      }

      const { baseRef, originMainFresh } = baseRefResult;

      const cleanupResult = await cleanupMergedManagedArtifacts({
        commandRunner,
        gitPath,
        ghPath,
        lsofPath,
        repoRootPath,
        worktreeListOutput: listResult.stdout,
        // A stale remote-tracking ref is sufficient to provision offline, but
        // never sufficient evidence for a destructive cleanup after a failed
        // fetch (origin/main may have been force-updated remotely).
        cleanupEligibleTicketIds: originMainFresh
          ? new Set(req.cleanupEligibleTicketIds ?? [])
          : new Set(),
        isTicketProtected: req.isTicketProtected ?? (() => false),
        timeoutMs,
        logWarn,
      });
      if (!cleanupResult.ok) {
        return {
          ok: false,
          reason: 'git-failed',
          message: cleanupResult.message,
        };
      }
      if (
        cleanupResult.remainingManagedArtifacts >= maxManagedWorktrees
        && !cleanupResult.retainedTicketIds.has(ticketId)
      ) {
        return {
          ok: false,
          reason: 'worktree-limit-reached',
          message:
            `agent-run worktree limit reached (${maxManagedWorktrees}); `
            + 'finish, merge, or manually remove an existing worktree before retrying',
        };
      }

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
  };

  // The cap is a check-then-add invariant. Serialize the complete provision
  // transaction so concurrent HTTP requests cannot all observe the same free
  // slot and then exceed the configured maximum.
  let provisioningTail: Promise<void> = Promise.resolve();

  return {
    provision(req: WorktreeProvisionRequest): Promise<WorktreeProvisionOutcome> {
      const previous = provisioningTail;
      let release!: () => void;
      provisioningTail = new Promise<void>((resolve) => {
        release = resolve;
      });

      return previous
        .then(() => provisionUnlocked(req))
        .finally(() => release());
    },
  };
}
