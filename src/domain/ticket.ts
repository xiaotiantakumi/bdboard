import type { DependencyEdge } from './dependency.js';
import type { Priority, Status } from './status.js';
import type { TicketModelRecord } from './ticket-model.js';
import type { TicketId } from './ticket-id.js';

export interface Ticket {
  readonly id: TicketId;
  readonly projectId: string;
  readonly title: string;
  readonly status: Status;
  readonly priority: Priority;
  readonly issueType: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly dependencies: readonly DependencyEdge[];
  readonly commentCount: number;
  readonly assignee?: string;
  readonly owner?: string;
  readonly startedAt?: Date;
  readonly closedAt?: Date;
  readonly deferUntil?: Date;
  readonly parentId?: TicketId;
  readonly description?: string;
  readonly notes?: string;
  readonly labels?: readonly string[];
  readonly models?: readonly TicketModelRecord[];
}
