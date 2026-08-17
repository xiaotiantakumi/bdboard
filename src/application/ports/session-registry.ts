import type { AgentSession } from '../../domain/session.js';

export interface SessionRegistry {
  listSessions(): Promise<readonly AgentSession[]>;
}
