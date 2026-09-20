import { compareStrings } from '../compare.js';
import type { Liveness, LivenessThresholds } from '../liveness.js';
import { computeLiveness, livenessRank } from '../liveness.js';
import type { AgentSession, SessionLink } from '../session.js';
import type { TicketId } from '../ticket-id.js';

export function buildSessionIdsByTicket(
  links: readonly SessionLink[],
): Map<TicketId, string[]> {
  const index = new Map<TicketId, string[]>();

  for (const link of links) {
    let sessionIds = index.get(link.ticketId);
    if (sessionIds === undefined) {
      sessionIds = [];
      index.set(link.ticketId, sessionIds);
    }
    sessionIds.push(link.sessionId);
  }

  return index;
}

export function deriveSessions(
  ticketId: TicketId,
  sessionById: ReadonlyMap<string, AgentSession>,
  sessionIdsByTicket: ReadonlyMap<TicketId, string[]>,
): readonly AgentSession[] {
  const sessionIds = [...(sessionIdsByTicket.get(ticketId) ?? [])].sort(
    compareStrings,
  );

  const seen = new Set<string>();
  const linked: AgentSession[] = [];

  for (const sessionId of sessionIds) {
    if (seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);

    const session = sessionById.get(sessionId);
    if (session !== undefined) {
      linked.push(session);
    }
  }

  return linked;
}

export function deriveLiveness(
  now: Date,
  sessions: readonly AgentSession[],
  thresholds?: LivenessThresholds,
): Liveness | null {
  if (sessions.length === 0) {
    return null;
  }

  let best: Liveness | null = null;
  let bestRank = Number.POSITIVE_INFINITY;

  for (const session of sessions) {
    const liveness = computeLiveness(now, session, thresholds);
    const rank = livenessRank(liveness);
    if (rank < bestRank) {
      bestRank = rank;
      best = liveness;
    }
  }

  return best;
}
