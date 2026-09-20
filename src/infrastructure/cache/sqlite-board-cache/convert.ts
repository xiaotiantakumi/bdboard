import type { CachedProject, CfdSnapshotRow, SessionLinkRow } from '../../../application/ports/board-cache.js';
import type { PendingDecision } from '../../../application/ports/human-decisions.js';
import type { InteractionRecord } from '../../../domain/interaction.js';
import type { Project } from '../../../domain/project.js';
import type { Ticket } from '../../../domain/ticket.js';
import type { SessionLinkSource } from '../../../domain/session.js';
import { deserializeTickets } from '../ticket-serialization.js';
import type {
  CfdSnapshotRowDb,
  InteractionRowDb,
  ProjectRow,
  SessionLinkRowDb,
} from './row-types.js';

export function parseAliasPaths(raw: string | null | undefined): readonly string[] {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function parsePrefixes(raw: string): readonly string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    if (!parsed.every((item): item is string => typeof item === 'string')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parsePendingDecisions(
  raw: string | null | undefined,
): readonly PendingDecision[] | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const decisions: PendingDecision[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') {
        continue;
      }

      const decision: PendingDecision = {
        id: record.id,
        kind: record.kind === 'gate' ? 'gate' : 'ticket',
        allowFreeform: record.allowFreeform === true,
        ...(typeof record.question === 'string' ? { question: record.question } : {}),
        ...(Array.isArray(record.options)
          ? {
              options: record.options
                .filter(
                  (option): option is { label: string; value: string } =>
                    typeof option === 'object' &&
                    option !== null &&
                    typeof (option as Record<string, unknown>).label === 'string' &&
                    typeof (option as Record<string, unknown>).value === 'string',
                )
                .map((option) => ({
                  label: option.label,
                  value: option.value,
                })),
            }
          : {}),
      };
      decisions.push(decision);
    }

    return decisions.length > 0 ? decisions : undefined;
  } catch {
    return undefined;
  }
}

export function rowToCachedProject(row: ProjectRow): CachedProject | null {
  const prefixes = parsePrefixes(row.prefixes);
  if (prefixes === null) {
    console.warn(
      `bdboard: skipping corrupt project cache row ${row.id}: invalid prefixes`,
    );
    return null;
  }

  let tickets: readonly Ticket[];
  try {
    tickets = deserializeTickets(row.tickets);
  } catch {
    console.warn(
      `bdboard: skipping corrupt project cache row ${row.id}: invalid tickets`,
    );
    return null;
  }

  const project: Project = {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    prefixes,
    aliasPaths: parseAliasPaths(row.alias_paths),
  };

  const pendingDecisions = parsePendingDecisions(row.pending_decisions);

  return {
    project,
    tickets,
    fingerprint: row.fingerprint,
    fetchedAt: new Date(row.fetched_at),
    ...(pendingDecisions !== undefined ? { pendingDecisions } : {}),
  };
}

export const rowToSessionLink = (row: SessionLinkRowDb): SessionLinkRow => ({
  projectId: row.project_id,
  link: {
    ticketId: row.ticket_id,
    sessionId: row.session_id,
    source: row.source as SessionLinkSource,
    confidence: row.confidence,
    observedAt: new Date(row.observed_at),
  },
});

export const rowToCfdSnapshot = (row: CfdSnapshotRowDb): CfdSnapshotRow => ({
  projectId: row.project_id,
  status: row.status,
  snapshotDate: row.snapshot_date,
  snapshottedAt: new Date(row.snapshotted_at),
  count: row.count,
});

export const rowToInteraction = (row: InteractionRowDb): InteractionRecord => ({
  id: row.id,
  at: new Date(row.at),
  actor: row.actor,
  ticketId: row.ticket_id,
  field: row.field,
  ...(row.old_value !== null ? { oldValue: row.old_value } : {}),
  ...(row.new_value !== null ? { newValue: row.new_value } : {}),
  ...(row.reason !== null ? { reason: row.reason } : {}),
});
