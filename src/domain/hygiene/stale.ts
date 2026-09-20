import { epicProgressFromIndex } from '../epic-progress.js';
import { isReady, type ReadinessContext } from '../readiness.js';
import { isOpenLike } from '../status.js';
import type { HygieneThresholds } from '../hygiene-thresholds.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';
import {
  formatLocalDateKey,
  hasBlockingDependencies,
  inProgressAnchor,
  isValidDate,
} from './shared.js';
import type { HygieneIssue } from './types.js';

export function checkOverdueDefer(
  ticket: Ticket,
  now: Date,
  timeZone?: string,
): HygieneIssue | null {
  if (ticket.status !== 'deferred') {
    return null;
  }
  if (!isValidDate(ticket.deferUntil)) {
    return null;
  }
  if (ticket.deferUntil.getTime() > now.getTime()) {
    return null;
  }

  // `bd defer --until=2026-08-10` は JST 深夜として `2026-08-09T15:00:00Z` に保存されるため、
  // `toISOString().slice(0,10)` のように UTC で切ると 1 日ずれる。Undo で元の日付へ戻すときに
  // ずれると別の日付に defer し直してしまうので、ローカルタイムゾーンで整形する。
  return {
    kind: 'overdue_defer',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: 'defer_until を過ぎていますが、まだ deferred のままです',
    severity: 'warning',
    deferUntil: formatLocalDateKey(ticket.deferUntil, timeZone),
  };
}

export function checkStaleEpic(
  ticket: Ticket,
  childrenIndex: ReadonlyMap<TicketId, readonly TicketId[]>,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  if (ticket.status === 'closed') {
    return null;
  }

  const progress = epicProgressFromIndex(ticket.id, childrenIndex, ticketById);
  if (progress === null || progress.total === 0 || progress.done !== progress.total) {
    return null;
  }

  return {
    kind: 'stale_epic',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: '子チケットはすべて完了していますが、エピックが open のままです',
    severity: 'warning',
  };
}

export function checkStaleInProgress(
  ticket: Ticket,
  now: Date,
  thresholds: HygieneThresholds,
  isPendingDecision: boolean,
): HygieneIssue | null {
  if (ticket.status !== 'in_progress' && ticket.status !== 'hooked') {
    return null;
  }
  // 確認待ちは stale_pending_decision の担当。deriveLane が human ラベルを
  // in_progress より優先する(src/domain/readiness.ts)ので、盤面が確認待ちに
  // 置いているカードに対して「長期 in_progress」と言うと、盤面に無いレーンの話に
  // なるうえ、同じ放置を2行で叱ることになる。
  if (isPendingDecision) {
    return null;
  }

  const anchor = inProgressAnchor(ticket);
  if (anchor === null) {
    return null;
  }

  const elapsedMs = now.getTime() - anchor.getTime();
  if (elapsedMs < thresholds.staleInProgressAfterMs) {
    return null;
  }

  const days = Math.floor(elapsedMs / (24 * 60 * 60_000));
  return {
    kind: 'stale_in_progress',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: `in_progress のまま ${days} 日以上経過しています`,
    severity: 'warning',
  };
}

export function checkUnblockedHighPriorityIdle(
  ticket: Ticket,
  ctx: ReadinessContext,
  now: Date,
  thresholds: HygieneThresholds,
): HygieneIssue | null {
  if (!isOpenLike(ticket.status)) {
    return null;
  }
  if (ticket.priority > thresholds.highPriorityMax) {
    return null;
  }
  if (!hasBlockingDependencies(ticket)) {
    return null;
  }
  if (!isReady(ticket, ctx, now)) {
    return null;
  }

  return {
    kind: 'unblocked_high_priority_idle',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: 'ブロックは解除済みですが、高優先チケットが未着手のままです',
    severity: 'warning',
  };
}

/**
 * 確認待ち(awaiting_human)のまま放置されているチケットを拾う。
 *
 * awaiting_human は ticket.status ではなく bd の human ラベル由来の派生レーンで
 * (src/domain/readiness.ts の deriveLane)、Ticket 単体からは判定できない。呼び出し側が
 * 集めた pendingDecisionKeys を渡してもらう前提で、渡されなければ何も出さない。
 *
 * closed は除外する。deriveLane も closed を done で上書きしていて(human ラベルの
 * 外し忘れでチケットが再浮上しないための保険)、盤面で done のカードが健全性だけ
 * 「確認待ちが放置されている」と言い出すのは矛盾になる。
 */
export function checkStalePendingDecision(
  ticket: Ticket,
  now: Date,
  thresholds: HygieneThresholds,
  isPendingDecision: boolean,
  lastCommentAt: Date | undefined,
): HygieneIssue | null {
  if (!isPendingDecision) {
    return null;
  }
  if (ticket.status === 'closed') {
    return null;
  }
  if (!isValidDate(ticket.updatedAt)) {
    return null;
  }

  // 遅いほうを取る。コメントのほうが古いこと自体は普通にある(コメント後に
  // 優先度を変えた等)ので、どちらか一方に決め打ちはしない。
  const anchor =
    isValidDate(lastCommentAt) && lastCommentAt.getTime() > ticket.updatedAt.getTime()
      ? lastCommentAt
      : ticket.updatedAt;

  const elapsedMs = now.getTime() - anchor.getTime();
  if (elapsedMs < thresholds.stalePendingDecisionAfterMs) {
    return null;
  }

  const days = Math.floor(elapsedMs / (24 * 60 * 60_000));
  return {
    kind: 'stale_pending_decision',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: `確認待ちのまま ${days} 日以上動きがありません`,
    severity: 'warning',
  };
}
