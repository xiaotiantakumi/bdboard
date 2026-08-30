import { compareStrings } from './compare.js';
import type { TicketId } from './ticket-id.js';

/** bd list --status in_progress --json の lease 関連フィールド */
export interface LeaseFields {
  readonly leaseExpiresAt: string | null | undefined;
  readonly heartbeatAt: string | null | undefined;
}

export interface StaleLeaseIssue {
  readonly ticketId: TicketId;
  readonly projectId: string;
  readonly leaseExpiresAt: string;
  readonly staleForMs: number;
}

/**
 * lease フィールドが揃っている in_progress だけが stale 判定の対象。
 * 両方 null/欠落の in_progress は stale 扱いしない（設計上の前提）。
 */
export function hasLeaseExpiry(fields: LeaseFields): fields is LeaseFields & {
  readonly leaseExpiresAt: string;
} {
  const raw = fields.leaseExpiresAt;
  return raw !== null && raw !== undefined && raw !== '';
}

function parseIsoMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** lease_expires_at が now より前なら stale */
export function isStaleLease(leaseExpiresAt: string, now: Date): boolean {
  const expiresMs = parseIsoMs(leaseExpiresAt);
  if (expiresMs === null) {
    return false;
  }
  return expiresMs < now.getTime();
}

/** 失効からの経過 ms。未失効なら 0 */
export function staleLeaseElapsedMs(leaseExpiresAt: string, now: Date): number {
  const expiresMs = parseIsoMs(leaseExpiresAt);
  if (expiresMs === null) {
    return 0;
  }
  return Math.max(0, now.getTime() - expiresMs);
}

export interface InProgressLeaseTicket {
  readonly id: TicketId;
  readonly leaseExpiresAt?: string | null;
  readonly heartbeatAt?: string | null;
}

export function detectStaleLeases(
  tickets: readonly InProgressLeaseTicket[],
  projectId: string,
  now: Date,
): readonly StaleLeaseIssue[] {
  const issues: StaleLeaseIssue[] = [];

  for (const ticket of tickets) {
    const fields: LeaseFields = {
      leaseExpiresAt: ticket.leaseExpiresAt,
      heartbeatAt: ticket.heartbeatAt,
    };
    if (!hasLeaseExpiry(fields)) {
      continue;
    }
    if (!isStaleLease(fields.leaseExpiresAt, now)) {
      continue;
    }

    issues.push({
      ticketId: ticket.id,
      projectId,
      leaseExpiresAt: fields.leaseExpiresAt,
      staleForMs: staleLeaseElapsedMs(fields.leaseExpiresAt, now),
    });
  }

  issues.sort((a, b) => {
    const projectDiff = compareStrings(a.projectId, b.projectId);
    if (projectDiff !== 0) {
      return projectDiff;
    }
    return compareStrings(a.ticketId, b.ticketId);
  });

  return issues;
}
