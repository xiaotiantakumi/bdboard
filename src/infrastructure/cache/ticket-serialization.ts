import type { DependencyEdge } from '../../domain/dependency.js';
import type { Priority, Status } from '../../domain/status.js';
import type { Ticket } from '../../domain/ticket.js';
import type { TicketId } from '../../domain/ticket-id.js';

interface SerializedDependencyEdge {
  readonly issueId: string;
  readonly dependsOnId: string;
  readonly kind: string;
}

interface SerializedTicket {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: Status;
  readonly priority: Priority;
  readonly issueType: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dependencies: readonly SerializedDependencyEdge[];
  readonly commentCount: number;
  readonly assignee?: string;
  readonly owner?: string;
  readonly startedAt?: string;
  readonly closedAt?: string;
  readonly deferUntil?: string;
  readonly parentId?: string;
  readonly description?: string;
  readonly notes?: string;
  readonly labels?: readonly string[];
  readonly manualSessionId?: string;
  readonly models?: readonly { readonly stage: string; readonly model: string }[];
}

function serializeDependency(edge: DependencyEdge): SerializedDependencyEdge {
  return {
    issueId: edge.issueId,
    dependsOnId: edge.dependsOnId,
    kind: edge.kind,
  };
}

function deserializeDependency(edge: SerializedDependencyEdge): DependencyEdge {
  return {
    issueId: edge.issueId as TicketId,
    dependsOnId: edge.dependsOnId as TicketId,
    kind: edge.kind,
  };
}

function serializeTicket(ticket: Ticket): SerializedTicket {
  return {
    id: ticket.id,
    projectId: ticket.projectId,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    issueType: ticket.issueType,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    dependencies: ticket.dependencies.map(serializeDependency),
    commentCount: ticket.commentCount,
    ...(ticket.assignee !== undefined ? { assignee: ticket.assignee } : {}),
    ...(ticket.owner !== undefined ? { owner: ticket.owner } : {}),
    ...(ticket.startedAt !== undefined
      ? { startedAt: ticket.startedAt.toISOString() }
      : {}),
    ...(ticket.closedAt !== undefined
      ? { closedAt: ticket.closedAt.toISOString() }
      : {}),
    ...(ticket.deferUntil !== undefined
      ? { deferUntil: ticket.deferUntil.toISOString() }
      : {}),
    ...(ticket.parentId !== undefined ? { parentId: ticket.parentId } : {}),
    ...(ticket.description !== undefined
      ? { description: ticket.description }
      : {}),
    ...(ticket.notes !== undefined ? { notes: ticket.notes } : {}),
    ...(ticket.labels !== undefined ? { labels: ticket.labels } : {}),
    ...(ticket.manualSessionId !== undefined
      ? { manualSessionId: ticket.manualSessionId }
      : {}),
    ...(ticket.models !== undefined ? { models: ticket.models } : {}),
  };
}

function deserializeTicket(raw: SerializedTicket): Ticket {
  const ticket: Ticket = {
    id: raw.id as TicketId,
    projectId: raw.projectId,
    title: raw.title,
    status: raw.status,
    priority: raw.priority,
    issueType: raw.issueType,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    dependencies: raw.dependencies.map(deserializeDependency),
    commentCount: raw.commentCount ?? 0,
    ...(raw.assignee !== undefined ? { assignee: raw.assignee } : {}),
    ...(raw.owner !== undefined ? { owner: raw.owner } : {}),
    ...(raw.startedAt !== undefined ? { startedAt: new Date(raw.startedAt) } : {}),
    ...(raw.closedAt !== undefined ? { closedAt: new Date(raw.closedAt) } : {}),
    ...(raw.deferUntil !== undefined ? { deferUntil: new Date(raw.deferUntil) } : {}),
    ...(raw.parentId !== undefined ? { parentId: raw.parentId as TicketId } : {}),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.notes !== undefined ? { notes: raw.notes } : {}),
    ...(raw.labels !== undefined ? { labels: raw.labels } : {}),
    ...(raw.manualSessionId !== undefined
      ? { manualSessionId: raw.manualSessionId }
      : {}),
    ...(raw.models !== undefined ? { models: raw.models } : {}),
  };

  return ticket;
}

export function serializeTickets(tickets: readonly Ticket[]): string {
  const serialized = tickets.map(serializeTicket);
  return JSON.stringify(serialized);
}

export function deserializeTickets(json: string): readonly Ticket[] {
  const parsed = JSON.parse(json) as SerializedTicket[];
  return parsed.map(deserializeTicket);
}
