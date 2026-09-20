// bdboard-sso1.38: SessionListPanel.tsx から移した純ヘルパー・型。挙動は一切変えていない。
import type {
  AgentProcessDto,
  ProjectDto,
  SessionDto,
  SessionHistoryEntryDto,
} from '../../api';
import type { Liveness } from '../../liveness';

export type SessionListTab = 'active' | 'ended' | 'processes';

export interface SessionRow {
  session: SessionDto;
  projectName: string;
  liveness: Liveness;
}

export function buildSessionProjectMap(
  projects: readonly ProjectDto[],
): Map<string, { projectId: string; projectName: string }> {
  const map = new Map<string, { projectId: string; projectName: string }>();
  for (const project of projects) {
    for (const session of project.sessions) {
      map.set(session.sessionId, {
        projectId: project.id,
        projectName: project.name,
      });
    }
  }
  return map;
}

export function formatTicketLabel(ticket: SessionHistoryEntryDto['tickets'][number]): string {
  if (ticket.title !== undefined) {
    return `${ticket.ticketId} — ${ticket.title}`;
  }
  return ticket.ticketId;
}

export function processProjectLabel(process: AgentProcessDto): string {
  return process.projectName ?? process.cwd;
}
