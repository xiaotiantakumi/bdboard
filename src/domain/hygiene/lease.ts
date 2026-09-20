import type { LeftoverCandidate } from '../git-worktree.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';
import type { HygieneIssue } from './types.js';

/**
 * worktree かブランチのどちらかが残っている = 生存の代理指標 (bdboard-rkde)。
 * checkMergedLeftover / checkReclaimedLiveWorktree の判定条件をここに集約する。
 * ハーネス KPI の誤回収件数 (bdboard-t3ct, computeReclaimKpi) もこれを使う —
 * 生存判定を2箇所で別々に実装すると、片方だけ直したときにズレる。
 */
export function hasLiveWorktreeEvidence(candidate: LeftoverCandidate): boolean {
  return candidate.worktreePath !== null || candidate.branchName !== null;
}

export function checkMergedLeftover(
  candidate: LeftoverCandidate,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  if (!hasLiveWorktreeEvidence(candidate)) {
    return null;
  }

  const ticket = ticketById.get(candidate.ticketId);
  if (ticket === undefined) {
    return null;
  }
  if (ticket.status !== 'closed') {
    return null;
  }
  if (ticket.projectId !== candidate.projectId) {
    return null;
  }

  let message: string;
  if (candidate.worktreePath !== null && candidate.branchName !== null) {
    message = 'チケットは closed ですが worktree とブランチが残っています';
  } else if (candidate.worktreePath !== null) {
    message = 'チケットは closed ですが worktree が残っています';
  } else {
    message = 'チケットは closed ですがブランチが残っています';
  }

  return {
    kind: 'merged_leftover',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message,
    severity: 'warning',
    cleanup: {
      repoRootPath: candidate.repoRootPath,
      worktreePath: candidate.worktreePath,
      branchName: candidate.branchName,
    },
  };
}

/**
 * merged_leftover の鏡像 (bdboard-rkde)。
 *
 * merged_leftover は「チケットは closed なのに worktree/ブランチが残っている」を見る。
 * こちらは **「チケットは open (＝ bd ready が空きとして提示する) なのに worktree か
 * ブランチが存在する」** を見る。
 *
 * この盤面は 2026-09-05 に 4 件同時に発生した。常時稼働サーバーの reclaim スケジューラが
 * lease だけを見て回収するため、heartbeat を打っていない生存セッションのチケットが
 * 作業中に open へ戻される。当人はそのまま PR を出すので、台帳だけが「空き」と言い続ける。
 * 回収そのものは `bd history <id> --events` に `lease_reclaimed` として残る (実測 2026-09-05:
 * `05:52:41 lease_reclaimed by ...`。bd history は UTC 表記)。ただし `bd show` には出ないので、台帳を1件ずつ開かない
 * 限り気付けない。この述語は**盤面から候補を一覧にする**ためのもので、手動の
 * `bd update -s open` との確定的な切り分けは上の history コマンドが担う。
 *
 * worktree/ブランチの存在を生存の代理指標に使えるのは、ワークフロー上それらが
 * claim からマージ後の掃除までの間しか存在しないため (docs/GIT-WORKFLOW.md)。
 * 掃除漏れとの区別は付かないが、掃除漏れもまた対処すべき盤面なので実害はない。
 *
 * in_progress は対象外。そちらは lease が生きている正常な状態か、さもなくば
 * stale_in_progress が拾う。
 */
export function checkReclaimedLiveWorktree(
  candidate: LeftoverCandidate,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  if (!hasLiveWorktreeEvidence(candidate)) {
    return null;
  }

  const ticket = ticketById.get(candidate.ticketId);
  if (ticket === undefined) {
    return null;
  }
  if (ticket.status !== 'open') {
    return null;
  }
  if (ticket.projectId !== candidate.projectId) {
    return null;
  }

  // 助詞の付き方は merged_leftover (上) と揃える。分岐ごとに文全体を組むのは
  // `${evidence} が` にすると「ブランチ が」と不自然に割れるため。
  let evidence: string;
  if (candidate.worktreePath !== null && candidate.branchName !== null) {
    evidence = 'チケットは open ですが worktree とブランチが残っています';
  } else if (candidate.worktreePath !== null) {
    evidence = 'チケットは open ですが worktree が残っています';
  } else {
    evidence = 'チケットは open ですがブランチが残っています';
  }

  return {
    kind: 'reclaimed_live_worktree',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message:
      `${evidence}。作業中に自動 reclaim された可能性があります。` +
      `bd ready が空きとして提示するので、作業が生きているなら bd update ${ticket.id} --claim で claim し直してください` +
      `（確認: bd history ${ticket.id} --events の直近の状態変更が lease_reclaimed なら自動回収です）`,
    severity: 'warning',
    // **cleanup は意図的に付けない (bdboard-rkde)。** merged_leftover と同じ候補を使うが、
    // 提案すべき対処は正反対である。UI の cleanup は lsof ガード付きとはいえ
    // `git worktree remove` + `branch -d` を出す (web/src/bdCommands.ts)。この kind が
    // 見ているのは「まだ生きているかもしれない作業」なので、そこに削除コマンドを
    // 添えるのは最悪の誤誘導になる。対処は claim し直すことで、message に書いてある。
  };
}
