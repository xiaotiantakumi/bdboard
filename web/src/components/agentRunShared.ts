import { ApiError, type AgentRunStatusDto } from '../api';
import { describeWriteError } from '../writeAccessMessage';

export const AGENT_RUN_POLL_INTERVAL_MS = 2000;
export const AGENT_RUN_POLL_MAX_FAILURES = 3;

const WORKTREE_DIRTY_ERROR_SUFFIX = ': uncommitted changes prevent agent run';
// git-worktree-provisioner.ts の formatWorktreeBranchMismatchMessage と同じ affix。
const WORKTREE_BRANCH_MISMATCH_ON_BRANCH = ': on branch ';
const WORKTREE_BRANCH_MISMATCH_EXPECTED = ', expected ';

function extractWorktreeBranchMismatchBranch(
  errorMessage: string | undefined,
): string | undefined {
  if (errorMessage === undefined) {
    return undefined;
  }

  const onBranchIndex = errorMessage.indexOf(WORKTREE_BRANCH_MISMATCH_ON_BRANCH);
  if (onBranchIndex === -1) {
    return undefined;
  }

  const afterOnBranch = errorMessage.slice(
    onBranchIndex + WORKTREE_BRANCH_MISMATCH_ON_BRANCH.length,
  );
  const expectedIndex = afterOnBranch.indexOf(WORKTREE_BRANCH_MISMATCH_EXPECTED);
  if (expectedIndex === -1) {
    return undefined;
  }

  const actualBranch = afterOnBranch.slice(0, expectedIndex).trim();
  return actualBranch.length > 0 ? actualBranch : undefined;
}

export function isAgentRunInProgress(status: AgentRunStatusDto): boolean {
  return (
    status === 'pending' || status === 'running' || status === 'cancelling'
  );
}

export function describeRunStartError(error: unknown): string {
  if (error instanceof ApiError) {
    // 分岐はサーバーが返す機械可読な `reason` で行う。`error` の文言は
    // `<worktree path>: uncommitted changes prevent agent run` という可変の
    // 形なので、表示用のパス抽出にだけ使い、判定には使わない。
    if (error.status === 409 && error.reason === 'worktree-dirty') {
      const path = error.errorMessage?.endsWith(WORKTREE_DIRTY_ERROR_SUFFIX)
        ? error.errorMessage.slice(0, -WORKTREE_DIRTY_ERROR_SUFFIX.length)
        : undefined;
      const base =
        '対象の worktree に未コミットの変更があるため実行できません。変更を整理してから再実行してください。';
      return path !== undefined && path.length > 0 ? `${base}(${path})` : base;
    }
    if (error.status === 409 && error.reason === 'worktree-branch-mismatch') {
      const actualBranch = extractWorktreeBranchMismatchBranch(error.errorMessage);
      const base =
        '対象の worktree が別のブランチにあるため実行できません。正しいブランチに切り替えてから再実行してください。';
      return actualBranch !== undefined
        ? `対象の worktree が別のブランチ（${actualBranch}）にあるため実行できません。正しいブランチに切り替えてから再実行してください。`
        : base;
    }
    if (error.status === 409 || error.status === 429) {
      switch (error.errorMessage) {
        case 'ticket is closed':
          return '完了済みのチケットは実行できません。';
        case 'ticket is blocked':
          return 'ブロック中のチケットは実行できません。';
        case 'ticket is deferred':
          return '保留中のチケットは実行できません。';
        case 'run already in progress':
          return 'このチケットは既に実行中です。';
        case 'too many concurrent runs':
          return '同時に実行できる上限に達しています。実行中のものが終わってからお試しください。';
        default:
          break;
      }
    }
  }
  return describeWriteError(error, 'エージェントの実行を開始できませんでした');
}
