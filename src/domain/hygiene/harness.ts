import { compareStrings } from '../compare.js';
import { parseHeartbeatLoopCommand } from '../heartbeat-loop.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';
import {
  STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND,
  type HarnessWorktreeLag,
  type HeartbeatLoopCandidate,
  type HygieneHeartbeatLoopTarget,
  type HygieneIssue,
} from './types.js';

/**
 * 「稼働中のセッションが、main から大きく遅れた worktree に居る」を拾う (bdboard-tdua)。
 *
 * 注入コピー (`.claude/skills/` と `.claude/settings.json`) は**チェックアウト単位**で、
 * worktree は作成時点の main で凍る。長命の worktree に居るセッションは、hooks も
 * スクリプトも規律本文も古いまま動き続ける。本人からは「ハーネスが入っている」ように
 * しか見えないので、**外から測らないと気付けない**。
 *
 * 実測 (2026-09-05): ハーネス差分 17 コミットの worktree で稼働していたセッションが、
 * 同じ日にハーネス改善 PR をマージしていた。自分がマージした改善が自分には効いていない。
 *
 * in_progress のチケットだけを見る。誰も作業していない worktree が古いのは当たり前で、
 * それは merged_leftover / reclaimed_live_worktree の担当。
 *
 * **見えている範囲は `bd/<id>` worktree に限る。** Claude Code の `isolation: "worktree"`
 * が作る `feature/<slug>` のような非チケット worktree は、紐づくチケットが無いため
 * Hygiene issue の形に載らない (HygieneIssue.ticketId は必須)。実測ではそちらのほうが
 * 深く凍っていた。そちらは `/api/hygiene` レスポンスの `nonTicketHarnessWorktrees`
 * (checkNonTicketHarnessWorktrees, non-ticket-harness-worktree.ts) が別レーンとして担当
 * する (bdboard-wadg)。
 */
export function checkStaleHarnessWorktree(
  lag: HarnessWorktreeLag,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  if (lag.commitsBehind < STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND) {
    return null;
  }

  const ticket = ticketById.get(lag.ticketId);
  if (ticket === undefined) {
    return null;
  }
  if (ticket.status !== 'in_progress') {
    return null;
  }
  if (ticket.projectId !== lag.projectId) {
    return null;
  }

  const message = lag.hasCommonAncestor
    ? `この worktree のハーネスは ${lag.baseRef} より ${lag.commitsBehind} コミットぶん古いままです。` +
      'ハーネス (.claude/skills と .claude/settings.json) はチェックアウト単位なので、' +
      'このセッションは worktree 作成時点の古い規律・hooks のまま動いています。' +
      `git -C ${lag.worktreePath} rebase ${lag.baseRef} で追従してください`
    : `この worktree は ${lag.baseRef} と共通の祖先がありません (履歴の作り直しより前に` +
      '作られた checkout)。ハーネス (.claude/skills と .claude/settings.json) は' +
      'チェックアウト単位なので、このセッションは worktree 作成時点の古い規律・hooks の' +
      'まま動いています。rebase では追いつけないので、まず ' +
      `git -C ${lag.worktreePath} の中身を確認してから、手で整理してください`;

  return {
    kind: 'stale_harness_worktree',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message,
    severity: 'warning',
    // cleanup は付けない。rebase は掃除ではないうえ、未コミットの成果を抱えた
    // worktree に対してワンクリック相当のコマンドを出すのは危険。
  };
}

export function checkOrphanHeartbeatLoop(
  candidate: HeartbeatLoopCandidate,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  const parsed = parseHeartbeatLoopCommand(candidate.commandLine);
  const knownTickets = parsed.ticketIdCandidates
    .map((ticketId) => ticketById.get(ticketId))
    .filter((ticket): ticket is Ticket => ticket !== undefined);

  if (knownTickets.length === 0) {
    return null;
  }

  if (parsed.ticketIdCandidates.length !== knownTickets.length) {
    return null;
  }

  const sortedKnownTickets = [...knownTickets].sort((a, b) =>
    compareStrings(a.id, b.id),
  );
  const ticketIds = sortedKnownTickets.map((ticket) => ticket.id);
  const representative = sortedKnownTickets[0]!;

  const allClosed = sortedKnownTickets.every((ticket) => ticket.status === 'closed');
  // sessionAlive が undefined（pidfile も --session-pid もない手書きループ）は、
  // 意図的に「セッション消失」を理由には警告しません（全チケット closed なら別理由で警告します）。
  // undefined は「セッションが死んでいる」ではなく、「生死が分からない」という意味です。
  // bdboard-7j49 で ps -o ppid= の ppid === 1 を代理指標にできるか実測し、却下しました。
  // nohup ... & でデタッチしたループは健全でも起動直後に ppid 1 になり、
  // 同梱の bd-heartbeat.sh 自身もこの形で起動するため、偽陽性と区別できません。
  // 実際に、起動から約1秒で ppid 1 になる健全なループを確認しています。
  // 親が tmux 等の長命プロセスなら、セッションが死んでも ppid は 1 にならず偽陰性です。
  // macOS では全プロセスの 718/892（約8割）が ppid 1 で、そもそも情報量がありません。
  // pgid リーダーの死亡や tty 無しも、健全なデタッチ済みループで成立するため使えません。
  // 再提案するなら代理指標ではなく、pidfile / --session-pid のような明示的なセッション識別子を増やします。
  const sessionGone = candidate.sessionAlive === false;

  if (!allClosed && !sessionGone) {
    return null;
  }

  const reason: HygieneHeartbeatLoopTarget['reason'] = allClosed
    ? 'all_closed'
    : 'session_gone';

  const ticketList = ticketIds.join(', ');
  const message =
    reason === 'all_closed'
      ? `対象チケットがすべて closed なのに heartbeat ループ (pid ${candidate.pid}) が残っています: ${ticketList}`
      : `起動元セッション (pid ${candidate.sessionPid}) は終了していますが heartbeat ループ (pid ${candidate.pid}) が残っています: ${ticketList}`;

  return {
    kind: 'orphan_heartbeat_loop',
    ticketId: representative.id,
    projectId: representative.projectId,
    message,
    severity: 'warning',
    heartbeatLoop: {
      pid: candidate.pid,
      ticketIds,
      reason,
      ...(candidate.sessionPid !== undefined ? { sessionPid: candidate.sessionPid } : {}),
      ...(candidate.startedAt !== undefined ? { startedAt: candidate.startedAt } : {}),
    },
  };
}
