// bdboard-sso1.81: agent-run-routes-test-support.ts のモジュール分割 (move only) で
// 切り出した、フェイク BoardCache とプロジェクト/チケットのフィクスチャ置き場。
import type { BoardCache, CachedProject } from '../../../application/ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../../../application/ports/board-cache-fakes.js';
import { compareStrings } from '../../../domain/compare.js';
import type { Project } from '../../../domain/project.js';
import { makeTicket } from '../../../domain/test-support.js';
import { DEFAULT_REPO_ROOT, NOW } from './constants.js';

export function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

export function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
  const entries = new Map<string, CachedProject>();

  return {
    entries,
    getProject(projectId: string): CachedProject | undefined {
      return entries.get(projectId);
    },
    putProject(entry: CachedProject): void {
      entries.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      entries.delete(projectId);
    },
    clear(): void {
      entries.clear();
    },
    getTranscriptOffset(): number | undefined {
      return undefined;
    },
    setTranscriptOffset(): void {},
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

export function seedOpenTicket(
  cache: BoardCache,
  ticketId: string,
  rootPath = DEFAULT_REPO_ROOT,
): void {
  const proj = project('proj-1', rootPath);
  const existing = cache.getProject(proj.id);
  const ticket = makeTicket({
    id: ticketId,
    projectId: proj.id,
    title: 'Example ticket',
    status: 'open',
  });
  cache.putProject({
    project: proj,
    tickets: existing ? [...existing.tickets, ticket] : [ticket],
    fingerprint: 'fp',
    fetchedAt: NOW,
  });
}
