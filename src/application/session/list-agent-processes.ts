import path from 'node:path';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache } from '../ports/board-cache.js';
import type { ScannedProcess } from '../ports/process-scanner.js';

export interface ListedAgentProcess {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt?: Date;
  readonly projectId?: string;
  readonly projectName?: string;
}

function normalizeRootPath(rootPath: string): string {
  if (
    rootPath.length > 1 &&
    (rootPath.endsWith('/') || rootPath.endsWith('\\'))
  ) {
    return rootPath.slice(0, -1);
  }
  return rootPath;
}

function matchesProject(cwd: string, rootPath: string): boolean {
  const normalized = normalizeRootPath(rootPath);
  if (cwd === normalized) {
    return true;
  }
  return cwd.startsWith(normalized + path.sep);
}

function resolveProject(
  cwd: string,
  projects: readonly Project[],
): Project | undefined {
  let best: { readonly project: Project; readonly matchedLength: number } | undefined;

  for (const project of projects) {
    if (!matchesProject(cwd, project.rootPath)) {
      continue;
    }

    const matchedLength = normalizeRootPath(project.rootPath).length;
    if (
      best === undefined ||
      matchedLength > best.matchedLength ||
      (matchedLength === best.matchedLength &&
        compareStrings(project.rootPath, best.project.rootPath) < 0)
    ) {
      best = { project, matchedLength };
    }
  }

  return best?.project;
}

export function listAgentProcesses(
  processes: readonly ScannedProcess[],
  cache: BoardCache,
): readonly ListedAgentProcess[] {
  const projects = cache.listProjects().map((entry) => entry.project);

  const listed: ListedAgentProcess[] = processes.map((proc) => {
    const project = resolveProject(proc.cwd, projects);
    return {
      pid: proc.pid,
      command: proc.command,
      cwd: proc.cwd,
      ...(proc.startedAt !== undefined ? { startedAt: proc.startedAt } : {}),
      ...(project !== undefined
        ? {
            projectId: project.id,
            projectName: project.name,
          }
        : {}),
    };
  });

  listed.sort((a, b) => {
    const aResolved = a.projectName !== undefined;
    const bResolved = b.projectName !== undefined;
    if (aResolved !== bResolved) {
      return aResolved ? -1 : 1;
    }

    if (aResolved && bResolved) {
      const nameCmp = compareStrings(a.projectName!, b.projectName!);
      if (nameCmp !== 0) {
        return nameCmp;
      }
    }

    return a.pid - b.pid;
  });

  return listed;
}
