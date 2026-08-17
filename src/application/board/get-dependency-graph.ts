import { buildDependencyGraph, type DependencyGraph } from '../../domain/dependency-graph.js';
import type { BoardCache } from '../ports/board-cache.js';

export interface GetDependencyGraphOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
}

export function getDependencyGraph(
  cache: BoardCache,
  options?: GetDependencyGraphOptions,
): DependencyGraph {
  const projectIdFilter = options?.projectIds;

  let entries = cache.listProjects();
  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const tickets = entries.flatMap((entry) => entry.tickets);
  return buildDependencyGraph(tickets);
}
