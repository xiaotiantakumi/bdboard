import type { AgentSession, SessionLink } from './session.js';
import type { Ticket } from './ticket.js';

const DEFAULT_DATE = new Date('2026-01-01T00:00:00.000Z');

const defaultTicket = (): Ticket => ({
  id: 'bdboard-abc',
  projectId: '/projects/bdboard',
  title: 'Test ticket',
  status: 'open',
  priority: 2,
  issueType: 'task',
  createdAt: DEFAULT_DATE,
  updatedAt: DEFAULT_DATE,
  dependencies: [],
  commentCount: 0,
});

export function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    ...defaultTicket(),
    ...overrides,
    dependencies: overrides.dependencies ?? defaultTicket().dependencies,
  };
}

const defaultSession = (): AgentSession => ({
  sessionId: 'session-1',
  pid: 12345,
  cwd: '/projects/bdboard',
  startedAt: DEFAULT_DATE,
  lastActivityAt: DEFAULT_DATE,
  alive: true,
});

export function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    ...defaultSession(),
    ...overrides,
  };
}

const defaultSessionLink = (): SessionLink => ({
  ticketId: 'bdboard-abc',
  sessionId: 'session-1',
  source: 'metadata',
  confidence: 1,
  observedAt: DEFAULT_DATE,
});

export function makeSessionLink(
  overrides: Partial<SessionLink> = {},
): SessionLink {
  return {
    ...defaultSessionLink(),
    ...overrides,
  };
}
