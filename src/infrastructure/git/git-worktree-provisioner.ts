// src/infrastructure/git/git-worktree-provisioner.ts は bdboard-sso1.21 でモジュール分割された。
// 実体は ./git-worktree-provisioner/ 配下:
//   - messages.ts             : worktree-branch-mismatch メッセージの定数/フォーマッタ
//   - git-command.ts          : git CLI 実行の共通ラッパー (runGit)
//   - paths.ts                : worktree パス/ブランチ名の組み立てとチケットID検証
//   - worktree-use.ts         : lsof による worktree 使用中判定
//   - merge-evidence.ts       : ブランチのマージ済み判定 (ancestor / squash-merged PR)
//   - cleanup-types.ts        : マージ済み管理下 worktree/ブランチ掃除の入出力型
//   - cleanup.ts / cleanup-stale-branches.ts : マージ済み管理下 worktree とブランチのみ
//     残った leftover の掃除 (200 行上限のため worktree ループとブランチループを分割)
//   - base-ref.ts             : origin/<mainBranch> の fetch/解決
//   - provision.ts            : provision() 本体 (worktree 再利用判定 → cleanup → 新規作成)
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
//
// createGitWorktreeProvisioner() はクラスではなくオブジェクトファクトリで、
// commandRunner/各種 CLI パス/上限/logWarn をクロージャで捕捉して provision() を返す
// 薄い合成層として残す。実際の provision ロジックは ./git-worktree-provisioner/provision.js
// の provisionTicketWorktree() へ、捕捉していた値を deps として明示的に渡して委譲する
// (クロージャ捕捉していた変数を明示引数に変換した点以外は挙動を変えていない)。
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  WorktreeProvisionOutcome,
  WorktreeProvisionRequest,
  WorktreeProvisioner,
} from '../../application/ports/worktree-provisioner.js';
import { provisionTicketWorktree, type ProvisionDeps } from './git-worktree-provisioner/provision.js';

const DEFAULT_GIT_PATH = 'git';
const DEFAULT_GH_PATH = 'gh';
const DEFAULT_LSOF_PATH = 'lsof';
const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_MANAGED_WORKTREES = 20;

export {
  WORKTREE_BRANCH_MISMATCH_ON_BRANCH,
  WORKTREE_BRANCH_MISMATCH_EXPECTED,
  formatWorktreeBranchMismatchMessage,
} from './git-worktree-provisioner/messages.js';
export { normalizePathForComparison } from './git-worktree-provisioner/paths.js';

export interface GitWorktreeProvisionerOptions {
  readonly commandRunner: CommandRunner;
  readonly gitPath?: string;
  readonly ghPath?: string;
  readonly lsofPath?: string;
  readonly timeoutMs?: number;
  readonly maxManagedWorktrees?: number;
  readonly logWarn?: (message: string) => void;
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
  const deps: ProvisionDeps = {
    commandRunner,
    gitPath,
    ghPath,
    lsofPath,
    timeoutMs,
    maxManagedWorktrees,
    logWarn,
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
        .then(() => provisionTicketWorktree(deps, req))
        .finally(() => release());
    },
  };
}
