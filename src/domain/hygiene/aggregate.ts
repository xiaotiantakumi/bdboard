import { compareStrings } from '../compare.js';
import { buildDirectChildrenIndex } from '../epic-progress.js';
import type { LeftoverCandidate } from '../git-worktree.js';
import { createReadinessContext } from '../readiness.js';
import {
  resolveHygieneThresholds,
  type HygieneThresholdsOverrides,
} from '../hygiene-thresholds.js';
import type { InFlightOverlap } from '../in-flight-overlap.js';
import type { Ticket } from '../ticket.js';
import { checkClosedWithoutEvidence } from './evidence.js';
import { checkOrphanHeartbeatLoop, checkStaleHarnessWorktree } from './harness.js';
import { checkMergedLeftover, checkReclaimedLiveWorktree } from './lease.js';
import { checkInFlightOverlaps } from './overlap.js';
import { pendingDecisionKey } from './shared.js';
import {
  checkOverdueDefer,
  checkStaleEpic,
  checkStaleInProgress,
  checkStalePendingDecision,
  checkUnblockedHighPriorityIdle,
} from './stale.js';
import { findDependencyCycles } from './cycles.js';
import type {
  HarnessWorktreeLag,
  HeartbeatLoopCandidate,
  HygieneIssue,
  HygieneIssueKind,
} from './types.js';

/**
 * 表示順。**Record にしてあるのは網羅性を tsc に強制させるため** — 配列だと新しい kind を
 * 足し忘れても `indexOf` が -1 を返して黙って先頭に並ぶ (bdboard-rkde のレビュー指摘)。
 */
const KIND_ORDER: Record<HygieneIssueKind, number> = {
  dependency_cycle: 0,
  overdue_defer: 1,
  stale_epic: 2,
  stale_in_progress: 3,
  unblocked_high_priority_idle: 4,
  stale_pending_decision: 5,
  closed_without_evidence: 6,
  merged_leftover: 7,
  reclaimed_live_worktree: 8,
  stale_harness_worktree: 9,
  orphan_heartbeat_loop: 10,
  in_flight_file_overlap: 11,
};

function compareIssues(a: HygieneIssue, b: HygieneIssue): number {
  const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kindDiff !== 0) {
    return kindDiff;
  }
  const projectDiff = compareStrings(a.projectId, b.projectId);
  if (projectDiff !== 0) {
    return projectDiff;
  }
  return compareStrings(a.ticketId, b.ticketId);
}

export function checkHygiene(
  tickets: readonly Ticket[],
  ctx: {
    readonly now: Date;
    readonly thresholds?: HygieneThresholdsOverrides;
    readonly leftoverCandidates?: readonly LeftoverCandidate[];
    /**
     * 走査した bd heartbeat ループ。ps を叩く必要があるのでドメインでは組み立てず、
     * 呼び出し側から受け取る。未指定なら orphan_heartbeat_loop は一切出ない。
     */
    readonly heartbeatLoops?: readonly HeartbeatLoopCandidate[];
    /**
     * 着手中 worktree 同士のファイル重複 (scanInFlightOverlaps の戻り)。git を叩く
     * 必要があるのでドメインでは組み立てず、呼び出し側から受け取る。未指定なら
     * in_flight_file_overlap は一切出ない。
     */
    readonly inFlightOverlaps?: readonly InFlightOverlap[];
    /**
     * 着手中 worktree が既定ブランチから何コミット遅れているか (scanHarnessWorktreeLags
     * の戻り)。git を叩く必要があるのでドメインでは組み立てず、呼び出し側から受け取る。
     * 未指定なら stale_harness_worktree は一切出ない。
     */
    readonly harnessWorktreeLags?: readonly HarnessWorktreeLag[];
    /**
     * 確認待ち(awaiting_human)のチケット。bd の human ラベル由来で Ticket からは
     * 判定できないため、呼び出し側が集めて渡す。キーは pendingDecisionKey() で
     * projectId を前置したもの。未指定なら stale_pending_decision は一切出ない。
     */
    readonly pendingDecisionKeys?: ReadonlySet<string>;
    /**
     * 確認待ちチケットの最終コメント日時。キーは pendingDecisionKeys と同じ
     * pendingDecisionKey()。stale_pending_decision のアンカーを
     * max(updatedAt, ここの値) にするためだけに使う。未指定なら updatedAt のみ。
     */
    readonly pendingCommentAnchors?: ReadonlyMap<string, Date>;
    /**
     * PR/検証の記録が **コメント本文** にあるチケットのキー集合
     * (`pendingDecisionKey(projectId, ticketId)` と同じ \0 結合キー)。
     *
     * コメント本文は bd を1件ずつ叩かないと取れず、全文をキャッシュに積むとメモリを
     * 食うので、アプリ層で「PR: / 検証: を含むコメントがあるか」という真偽値まで
     * 潰してから集合として渡す (pendingCommentAnchors と同じ設計)。未指定なら
     * コメントは見ず closeReason だけで判定する。
     */
    readonly closeEvidenceKeys?: ReadonlySet<string>;
    /**
     * コメント本文をまだ確認できていないチケットのキー集合
     * (`pendingDecisionKey` と同じ \0 結合キー)。
     *
     * bd comments は1件 0.8〜2.8s かかるので、アプリ層は1リクエストあたりの
     * フェッチ件数に上限を設ける。上限に達して未確認のまま残ったチケットは
     * 「証拠なし」ではなく **未確認** であり、ここに載る。
     *
     * 未確認は検出しない。証拠なしと同一視すると、キャッシュが冷えている間だけ
     * 100件規模の誤検知が並び、しばらくして勝手に消えることになる — hygiene は
     * 「まだ調べていない」を「問題あり」と言ってはいけない。
     */
    readonly closeEvidenceUnknownKeys?: ReadonlySet<string>;
    /**
     * コメント本文を読む手段があるか。false なら closed_without_evidence の判定自体を
     * 行わない。
     *
     * 一部が未確認のときは非検出にしているのに、コメントを1件も読めない環境で
     * だけ全件検出するのは逆立ちしている (未確認を「証拠なし」と断定することになる)。
     * 既定 true。
     */
    readonly closeEvidenceAvailable?: boolean;
    readonly timeZone?: string;
  },
): readonly HygieneIssue[] {
  const thresholds = resolveHygieneThresholds(ctx.thresholds);
  const closeEvidenceAvailable = ctx.closeEvidenceAvailable ?? true;
  const readiness = createReadinessContext(tickets);
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const childrenIndex = buildDirectChildrenIndex(tickets);
  const issues: HygieneIssue[] = [];

  for (const ticket of tickets) {
    const overdueDefer = checkOverdueDefer(ticket, ctx.now, ctx.timeZone);
    if (overdueDefer !== null) {
      issues.push(overdueDefer);
    }

    const staleEpic = checkStaleEpic(ticket, childrenIndex, ticketById);
    if (staleEpic !== null) {
      issues.push(staleEpic);
    }

    const decisionKey = pendingDecisionKey(ticket.projectId, ticket.id);
    const isPendingDecision = ctx.pendingDecisionKeys?.has(decisionKey) ?? false;

    const staleInProgress = checkStaleInProgress(
      ticket,
      ctx.now,
      thresholds,
      isPendingDecision,
    );
    if (staleInProgress !== null) {
      issues.push(staleInProgress);
    }

    const stalePendingDecision = checkStalePendingDecision(
      ticket,
      ctx.now,
      thresholds,
      isPendingDecision,
      ctx.pendingCommentAnchors?.get(decisionKey),
    );
    if (stalePendingDecision !== null) {
      issues.push(stalePendingDecision);
    }

    const unblockedIdle = checkUnblockedHighPriorityIdle(
      ticket,
      readiness,
      ctx.now,
      thresholds,
    );
    if (unblockedIdle !== null) {
      issues.push(unblockedIdle);
    }

    const closedWithoutEvidence = checkClosedWithoutEvidence(
      ticket,
      ctx.now,
      thresholds,
      ctx.closeEvidenceKeys,
      ctx.closeEvidenceUnknownKeys,
      closeEvidenceAvailable,
    );
    if (closedWithoutEvidence !== null) {
      issues.push(closedWithoutEvidence);
    }
  }

  if (ctx.leftoverCandidates !== undefined) {
    for (const candidate of ctx.leftoverCandidates) {
      const mergedLeftover = checkMergedLeftover(candidate, ticketById);
      if (mergedLeftover !== null) {
        issues.push(mergedLeftover);
      }
      // 同じ候補列を鏡像の述語でもう一度見る。両者は status で排他 (closed / open) なので
      // 1つの候補が両方に載ることはない。
      const reclaimedLive = checkReclaimedLiveWorktree(candidate, ticketById);
      if (reclaimedLive !== null) {
        issues.push(reclaimedLive);
      }
    }
  }

  if (ctx.harnessWorktreeLags !== undefined) {
    for (const lag of ctx.harnessWorktreeLags) {
      const staleHarness = checkStaleHarnessWorktree(lag, ticketById);
      if (staleHarness !== null) {
        issues.push(staleHarness);
      }
    }
  }

  if (ctx.heartbeatLoops !== undefined) {
    for (const candidate of ctx.heartbeatLoops) {
      const orphanHeartbeatLoop = checkOrphanHeartbeatLoop(candidate, ticketById);
      if (orphanHeartbeatLoop !== null) {
        issues.push(orphanHeartbeatLoop);
      }
    }
  }

  if (ctx.inFlightOverlaps !== undefined) {
    issues.push(...checkInFlightOverlaps(ctx.inFlightOverlaps, ticketById));
  }

  for (const cycle of findDependencyCycles(tickets)) {
    const representativeId = cycle.ticketIds[0]!;
    const representative = ticketById.get(representativeId);
    if (representative === undefined) {
      continue;
    }

    issues.push({
      kind: 'dependency_cycle',
      ticketId: representativeId,
      projectId: representative.projectId,
      message: `${cycle.ticketIds.length}件のチケットが循環依存(blocks)しています: ${cycle.ticketIds.join(', ')}`,
      severity: 'warning',
      cycleTicketIds: cycle.ticketIds,
      cycleEdges: cycle.edges,
    });
  }

  return [...issues].sort(compareIssues);
}
