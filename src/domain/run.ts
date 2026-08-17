import type { TicketId } from './ticket-id.js';

export const RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_MODES = ['spawn', 'resume'] as const;

export type RunMode = (typeof RUN_MODES)[number];

export interface Run {
  readonly id: string;
  readonly ticketId: TicketId;
  readonly runner: string;
  readonly mode: RunMode;
  readonly status: RunStatus;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly sessionId?: string;
  readonly exitCode?: number;
  readonly error?: string;
}
