import { Hono } from 'hono';
import { parseClampedIntQueryParam } from './parse-clamped-int-query-param.js';
import { getSessionHistory } from '../../application/session/get-session-history.js';
import { listAgentProcesses } from '../../application/session/list-agent-processes.js';
import { resolveSessionProject } from '../../application/session/link-sessions-to-projects.js';
import {
  toAgentProcessDto,
  toSessionDto,
  toSessionHistoryEntryDto,
  toSessionTailMessageDto,
} from './dto.js';
import { parseProjectIds, resolveLivenessThresholds } from './api-route-shared.js';
import type { ApiDeps } from './api-deps.js';

const SESSION_HISTORY_DEFAULT_LIMIT = 50;
const SESSION_HISTORY_MIN_LIMIT = 1;
const SESSION_HISTORY_MAX_LIMIT = 200;
const SESSION_TAIL_DEFAULT_LIMIT = 50;
const SESSION_TAIL_MIN_LIMIT = 1;
const SESSION_TAIL_MAX_LIMIT = 200;

function parseSessionHistoryLimit(raw: string | undefined): number {
  return parseClampedIntQueryParam(raw, {
    min: SESSION_HISTORY_MIN_LIMIT,
    max: SESSION_HISTORY_MAX_LIMIT,
    defaultValue: SESSION_HISTORY_DEFAULT_LIMIT,
  });
}

function parseSessionTailLimit(raw: string | undefined): number {
  return parseClampedIntQueryParam(raw, {
    min: SESSION_TAIL_MIN_LIMIT,
    max: SESSION_TAIL_MAX_LIMIT,
    defaultValue: SESSION_TAIL_DEFAULT_LIMIT,
  });
}

export function createSessionProcessRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/api/sessions/history', async (c) => {
    const now = deps.now();
    const livenessThresholds = await resolveLivenessThresholds(deps);
    const limit = parseSessionHistoryLimit(c.req.query('limit'));
    const projectIds = parseProjectIds(c.req.query('projects'));
    const sessions = deps.sessions?.() ?? [];
    const links = deps.links?.() ?? [];
    const history = getSessionHistory(sessions, links, deps.cache, {
      limit,
      ...(projectIds !== undefined ? { projectIds } : {}),
    });

    return c.json(
      history.map((entry) =>
        toSessionHistoryEntryDto(entry, now, livenessThresholds),
      ),
    );
  });

  app.get('/api/sessions/:id/tail', async (c) => {
    if (deps.sessionTail === undefined) {
      return c.json({ error: 'session tail reader not available' }, 501);
    }

    const id = c.req.param('id');
    const limit = parseSessionTailLimit(c.req.query('lines'));
    const sessions = deps.sessions?.() ?? [];
    const session = sessions.find((entry) => entry.sessionId === id);
    if (session === undefined) {
      return c.json({ error: 'session not found' }, 404);
    }

    const projects = deps.cache.listProjects().map((entry) => entry.project);
    const project = resolveSessionProject(session.cwd, projects);
    if (project === undefined) {
      return c.json({ error: 'session not found' }, 404);
    }

    const messages = await deps.sessionTail.readTail(session, limit);
    if (messages === undefined) {
      return c.json({ error: 'transcript not found' }, 404);
    }

    return c.json({
      sessionId: session.sessionId,
      messages: messages.map(toSessionTailMessageDto),
    });
  });

  app.get('/api/sessions', async (c) => {
    const now = deps.now();
    const livenessThresholds = await resolveLivenessThresholds(deps);
    const sessions = deps.sessions?.() ?? [];
    return c.json(
      sessions.map((session) => toSessionDto(session, now, livenessThresholds)),
    );
  });

  app.get('/api/processes', async (c) => {
    if (deps.processScanner === undefined) {
      return c.json({ error: 'process scanner not available' }, 501);
    }

    const scanned = await deps.processScanner.listAgentProcesses();
    const listed = listAgentProcesses(scanned, deps.cache);
    return c.json(listed.map(toAgentProcessDto));
  });

  return app;
}
