// bdboard-sso1.11: HygienePanel.tsx から非チケット harness worktree 警告の
// 表示専用 JSX を移動しただけのファイル。挙動は一切変えていない。
import { projectNameFallback, type NonTicketHarnessWorktreeWarningDto } from '../../api';
import { NON_TICKET_HARNESS_WORKTREE_KIND_LABEL } from './constants';

export function NonTicketHarnessWorktreeSection({
  nonTicketHarnessWorktrees,
}: {
  readonly nonTicketHarnessWorktrees: readonly NonTicketHarnessWorktreeWarningDto[];
}) {
  if (nonTicketHarnessWorktrees.length === 0) {
    return null;
  }
  return (
    <li key="non-ticket-harness-worktrees">
      <div className="hygiene-merge-slot-group">
        {nonTicketHarnessWorktrees.map((worktree) => (
          <div
            key={`${worktree.projectId}:${worktree.worktreePath}`}
            className="hygiene-issue-row hygiene-issue-row-static"
          >
            <span className="hygiene-kind-badge hygiene-kind-stale_harness_worktree">
              {NON_TICKET_HARNESS_WORKTREE_KIND_LABEL}
            </span>
            <span className="badge badge-stalled">警告</span>
            <span className="hygiene-issue-project" title={worktree.projectId}>
              {projectNameFallback(worktree.projectId)}
            </span>
            <span className="hygiene-issue-id">{worktree.branchName}</span>
            <span className="hygiene-issue-message">{worktree.message}</span>
          </div>
        ))}
      </div>
    </li>
  );
}
