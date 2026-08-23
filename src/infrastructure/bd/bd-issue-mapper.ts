import { z } from 'zod';
import { BdError } from '../../application/ports/issue-repository.js';
import { compareStrings } from '../../domain/compare.js';
import type { DependencyEdge } from '../../domain/dependency.js';
import type { Priority } from '../../domain/status.js';
import type { Ticket } from '../../domain/ticket.js';
import { parseTicketId } from '../../domain/ticket-id.js';
import { parseTicketModelRecords } from '../../domain/ticket-model.js';
import { parseTicketManualSessionId } from '../../domain/ticket-session-link.js';
import { bdIssueSchema, type BdIssue } from './bd-issue-schema.js';

const MAX_ZOD_ISSUES = 5;

export interface MappedBdList {
  readonly tickets: readonly Ticket[];
  /** parse/変換に失敗して読み飛ばした行 */
  readonly skipped: readonly {
    readonly index: number;
    readonly id?: string;
    readonly detail: string;
  }[];
}

type OptionalTicketFields = {
  -readonly [K in
    | 'assignee'
    | 'startedAt'
    | 'closedAt'
    | 'deferUntil'
    | 'parentId'
    | 'description'
    | 'notes'
    | 'labels'
    | 'manualSessionId'
    | 'models']?: Ticket[K];
};

function summarizeZodError(error: { issues: readonly { path: readonly (string | number)[]; message: string }[] }): string {
  return error.issues
    .slice(0, MAX_ZOD_ISSUES)
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

function extractRawId(element: unknown): string | undefined {
  if (
    typeof element === 'object' &&
    element !== null &&
    typeof (element as { id?: unknown }).id === 'string'
  ) {
    return (element as { id: string }).id;
  }
  return undefined;
}

function parseRequiredDate(value: string, field: string, projectId: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BdError('schema-mismatch', projectId, `invalid date in ${field}: ${value}`);
  }
  return date;
}

function parseOptionalDate(
  value: string | undefined,
  field: string,
  projectId: string,
): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseRequiredDate(value, field, projectId);
}

function mapDependencies(raw: BdIssue): readonly DependencyEdge[] {
  if (raw.dependencies === undefined) {
    return [];
  }

  return raw.dependencies.map((dep) => ({
    issueId: dep.issue_id,
    dependsOnId: dep.depends_on_id,
    kind: dep.type,
  }));
}

export function mapBdIssueToTicket(raw: BdIssue, projectId: string): Ticket {
  const ticket: Ticket = {
    id: raw.id,
    projectId,
    title: raw.title,
    status: raw.status,
    priority: raw.priority as Priority,
    issueType: raw.issue_type,
    owner: raw.owner,
    createdAt: parseRequiredDate(raw.created_at, 'created_at', projectId),
    updatedAt: parseRequiredDate(raw.updated_at, 'updated_at', projectId),
    dependencies: mapDependencies(raw),
    commentCount: raw.comment_count,
  };

  const optionalFields: OptionalTicketFields = {};

  if (raw.assignee !== undefined) {
    optionalFields.assignee = raw.assignee;
  }
  if (raw.started_at !== undefined) {
    optionalFields.startedAt = parseOptionalDate(raw.started_at, 'started_at', projectId);
  }
  if (raw.closed_at !== undefined) {
    optionalFields.closedAt = parseOptionalDate(raw.closed_at, 'closed_at', projectId);
  }
  if (raw.defer_until !== undefined) {
    optionalFields.deferUntil = parseOptionalDate(raw.defer_until, 'defer_until', projectId);
  }
  if (raw.parent !== undefined) {
    optionalFields.parentId = raw.parent;
  }
  if (raw.description !== undefined) {
    optionalFields.description = raw.description;
  }
  if (raw.notes !== undefined) {
    optionalFields.notes = raw.notes;
  }
  if (raw.labels !== undefined) {
    optionalFields.labels = raw.labels;
  }
  const manualSessionId = parseTicketManualSessionId(raw.metadata);
  if (manualSessionId !== undefined) {
    optionalFields.manualSessionId = manualSessionId;
  }
  const models = parseTicketModelRecords(raw.metadata);
  if (models.length > 0) {
    optionalFields.models = models;
  }

  return { ...ticket, ...optionalFields };
}

/**
 * Labels bd puts on its own coordination beads, which are not work tickets.
 * `gt:slot` marks the `<prefix>-merge-slot` bead that serializes the merge
 * queue. Showing it on the board would put a P0 card named "Merge Slot" next
 * to real work (bdboard-mwd).
 */
const COORDINATION_LABELS: ReadonlySet<string> = new Set(['gt:slot']);

function isCoordinationBead(raw: BdIssue): boolean {
  return raw.labels?.some((label) => COORDINATION_LABELS.has(label)) ?? false;
}

export function mapBdListToTickets(raw: unknown, projectId: string): MappedBdList {
  const arrayResult = z.array(z.unknown()).safeParse(raw);
  if (!arrayResult.success) {
    throw new BdError('schema-mismatch', projectId, summarizeZodError(arrayResult.error));
  }

  const tickets: Ticket[] = [];
  const skipped: MappedBdList['skipped'][number][] = [];

  for (const [index, element] of arrayResult.data.entries()) {
    const parsed = bdIssueSchema.safeParse(element);
    if (!parsed.success) {
      skipped.push({
        index,
        id: extractRawId(element),
        detail: summarizeZodError(parsed.error),
      });
      continue;
    }

    // Excluded silently, not recorded in `skipped`: this is normal operation,
    // not a data problem, and `skipped` drives a user-visible warning.
    if (isCoordinationBead(parsed.data)) {
      continue;
    }

    try {
      tickets.push(mapBdIssueToTicket(parsed.data, projectId));
    } catch (error: unknown) {
      const detail = error instanceof BdError ? error.detail : String(error);
      skipped.push({
        index,
        id: parsed.data.id,
        detail,
      });
    }
  }

  return { tickets, skipped };
}

export function collectPrefixes(tickets: readonly Ticket[]): readonly string[] {
  const prefixSet = new Set<string>();

  for (const ticket of tickets) {
    try {
      const { prefix } = parseTicketId(ticket.id);
      prefixSet.add(prefix);
    } catch {
      // invalid ids are silently ignored
    }
  }

  return [...prefixSet].sort(compareStrings);
}
