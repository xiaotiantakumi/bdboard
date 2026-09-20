import type { DeferUrgency } from '../defer.js';
import type { EpicProgress } from '../epic-progress.js';
import type { Liveness, LivenessThresholds } from '../liveness.js';
import type { Lane } from '../readiness.js';
import type { AgentSession, SessionLink } from '../session.js';
import type { StalledThresholds } from '../stalled.js';
import type { Priority } from '../status.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';

export interface BoardCard {
  readonly ticket: Ticket;
  readonly lane: Lane;
  readonly projectId: string;
  readonly sessions: readonly AgentSession[];
  readonly liveness: Liveness | null;
  readonly blockedBy: readonly TicketId[];
  readonly blocks: readonly TicketId[];
  readonly unblocksCount: number;
  readonly stalled: boolean;
  readonly epicProgress: EpicProgress | null;
  readonly deferDays: number | null;
  readonly deferUrgency: DeferUrgency | null;
  readonly effectivePriority: Priority;
  readonly priorityInheritedFrom: TicketId | null;
}

export interface Board {
  readonly cards: readonly BoardCard[];
  readonly lanes: Readonly<Record<Lane, readonly BoardCard[]>>;
}

export interface BuildBoardInput {
  readonly projectId: string;
  readonly tickets: readonly Ticket[];
  readonly now: Date;
  readonly sessions?: readonly AgentSession[];
  readonly links?: readonly SessionLink[];
  readonly livenessThresholds?: LivenessThresholds;
  readonly stalledThresholds?: StalledThresholds;
  /** bd の human ラベルが付いたチケットID集合。指定分は awaiting_human レーンへ振り分ける */
  readonly humanLabeledIds?: ReadonlySet<TicketId>;
  /** IANA timezone for defer-day truncation. Omit to use the process timezone. */
  readonly timeZone?: string;
}
