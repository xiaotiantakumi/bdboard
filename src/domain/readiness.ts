import { compareStrings } from './compare.js';
import { isOpenLike, type Status } from './status.js';
import type { Ticket } from './ticket.js';
import type { TicketId } from './ticket-id.js';

export interface ReadinessContext {
  /** 既知チケットの status を返す。未知なら undefined */
  readonly statusOf: (id: TicketId) => Status | undefined;
}

export function createReadinessContext(
  tickets: readonly Ticket[],
): ReadinessContext {
  const statusById = new Map<TicketId, Status>();
  for (const ticket of tickets) {
    if (!statusById.has(ticket.id)) {
      statusById.set(ticket.id, ticket.status);
    }
  }

  return {
    statusOf: (id) => statusById.get(id),
  };
}

/** 未クローズの blocks ブロッカーID一覧(kind==='blocks' のみ、未知IDは除外) */
export function openBlockerIds(
  ticket: Ticket,
  ctx: ReadinessContext,
): readonly TicketId[] {
  const seen = new Set<TicketId>();
  const blockers: TicketId[] = [];

  for (const edge of ticket.dependencies) {
    if (edge.kind !== 'blocks' || edge.issueId !== ticket.id) {
      continue;
    }

    const status = ctx.statusOf(edge.dependsOnId);
    if (status === undefined || status === 'closed') {
      continue;
    }

    if (!seen.has(edge.dependsOnId)) {
      seen.add(edge.dependsOnId);
      blockers.push(edge.dependsOnId);
    }
  }

  return blockers.sort(compareStrings);
}

export function isDeferred(ticket: Ticket, now: Date): boolean {
  return (
    ticket.deferUntil !== undefined &&
    ticket.deferUntil.getTime() > now.getTime()
  );
}

export function isBlocked(ticket: Ticket, ctx: ReadinessContext): boolean {
  return isOpenLike(ticket.status) && openBlockerIds(ticket, ctx).length > 0;
}

export function isBlockedWide(ticket: Ticket, ctx: ReadinessContext): boolean {
  return (
    (isOpenLike(ticket.status) ||
      ticket.status === 'in_progress' ||
      ticket.status === 'hooked') &&
    openBlockerIds(ticket, ctx).length > 0
  );
}

export function isReady(
  ticket: Ticket,
  ctx: ReadinessContext,
  now: Date,
): boolean {
  return (
    isOpenLike(ticket.status) && !isBlocked(ticket, ctx) && !isDeferred(ticket, now)
  );
}

// 表示順は「着手可能 → 進行中 → 確認待ち → ブロック → 完了」(bdboard-662)。表示順は
// web/src/api.ts の LANES が実際に握る。ここでの並びは DTO の内部キー順にしか影響しないが、
// 意図を揃えるため同じ並びにしている。
//
// bdboard-662: 「保留(deferred)」は独立レーンを持たず「ブロック(blocked)」に統合される。
// これは表示上の統合のみで、bd 上の status は 'deferred' のまま変更しない(defer_until の
// 情報も維持され、bd ready の除外挙動も変わらない)。deriveLane が deferred 判定を
// blocked へ振り替えることで実現している。
export const LANES = [
  'ready',
  'in_progress',
  'awaiting_human',
  'blocked',
  'done',
] as const;

export type Lane = (typeof LANES)[number];

export function deriveLane(
  ticket: Ticket,
  ctx: ReadinessContext,
  now: Date,
  humanLabeledIds?: ReadonlySet<TicketId>,
): Lane {
  if (ticket.status === 'closed') {
    // closed は最終状態として最優先: human ラベルが残っていても done を上書きしない
    // (bd human respond で通常ラベルは外れるはずだが、外れ忘れでチケットが再浮上しないための保険)。
    return 'done';
  }
  if (humanLabeledIds?.has(ticket.id) === true) {
    return 'awaiting_human';
  }
  if (ticket.status === 'in_progress' || ticket.status === 'hooked') {
    return 'in_progress';
  }
  if (ticket.status === 'blocked') {
    return 'blocked';
  }
  if (isBlocked(ticket, ctx)) {
    return 'blocked';
  }
  if (ticket.status === 'deferred' || isDeferred(ticket, now)) {
    // bdboard-662: 保留はブロックへ表示統合。status 自体は 'deferred' のまま。
    return 'blocked';
  }
  // カスタム status は ready レーンに載せるが isReady() では除外する（保守的）
  return 'ready';
}
