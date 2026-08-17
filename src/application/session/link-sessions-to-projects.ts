import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import type { AgentSession } from '../../domain/session.js';

function normalizeRootPath(rootPath: string): string {
  if (rootPath.length > 1 && rootPath.endsWith('/')) {
    return rootPath.slice(0, -1);
  }
  return rootPath;
}

function matchesAtPath(cwd: string, normalizedPath: string): boolean {
  if (cwd === normalizedPath) {
    return true;
  }
  return cwd.startsWith(`${normalizedPath}/`);
}

/** マッチしたパス(正規化済み)を返す。マッチしなければ undefined。最長のものを返す。 */
function matchedPathFor(cwd: string, project: Project): string | undefined {
  let best: string | undefined;

  for (const pathToMatch of [project.rootPath, ...project.aliasPaths]) {
    const normalized = normalizeRootPath(pathToMatch);
    if (!matchesAtPath(cwd, normalized)) {
      continue;
    }

    if (best === undefined) {
      best = normalized;
      continue;
    }

    if (normalized.length > best.length) {
      best = normalized;
    } else if (normalized.length === best.length && compareStrings(normalized, best) < 0) {
      best = normalized;
    }
  }

  return best;
}

/** Resolves which project a session cwd belongs to, if any. */
export function resolveSessionProject(
  cwd: string,
  projects: readonly Project[],
): Project | undefined {
  let best: { readonly project: Project; readonly matched: string } | undefined;

  for (const project of projects) {
    const matched = matchedPathFor(cwd, project);
    if (matched === undefined) {
      continue;
    }

    if (
      best === undefined ||
      matched.length > best.matched.length ||
      (matched.length === best.matched.length && compareStrings(matched, best.matched) < 0)
    ) {
      best = { project, matched };
    }
  }

  return best?.project;
}

/** Groups sessions by project id. Unmatched sessions are omitted. */
export function groupSessionsByProject(
  sessions: readonly AgentSession[],
  projects: readonly Project[],
): ReadonlyMap<string, readonly AgentSession[]> {
  const map = new Map<string, AgentSession[]>();

  for (const session of sessions) {
    const project = resolveSessionProject(session.cwd, projects);
    if (project === undefined) {
      continue;
    }

    const existing = map.get(project.id);
    if (existing !== undefined) {
      existing.push(session);
    } else {
      map.set(project.id, [session]);
    }
  }

  const result = new Map<string, readonly AgentSession[]>();
  for (const [id, projectSessions] of map) {
    if (projectSessions.length === 0) {
      continue;
    }
    projectSessions.sort((a, b) => compareStrings(a.sessionId, b.sessionId));
    result.set(id, projectSessions);
  }

  return result;
}
