/** bdboard-4y8q.6.3: discovery 一覧を基準に refresh 結果の観察へ渡す。 */
import type { Project } from '../../domain/project.js';
import type { BoardCache } from '../ports/board-cache.js';
import type { ProjectDiscovery } from '../ports/project-discovery.js';
import type { RefreshResult } from './refresh-projects.js';
import { readProjectRefs } from './read-cached-projects.js';

export interface RefreshResultObserverDeps {
  readonly discovery: ProjectDiscovery;
  readonly cache: Pick<BoardCache, 'listProjects' | 'listProjectRefs'>;
  readonly onResult?: (result: RefreshResult, projects: readonly Project[]) => void;
  readonly logError: (message: string) => void;
}
export interface RefreshResultObserver {
  readonly discovery: ProjectDiscovery;
  observe(result: RefreshResult): void;
}

export function createRefreshResultObserver(deps: RefreshResultObserverDeps): RefreshResultObserver {
  if (deps.onResult === undefined) return { discovery: deps.discovery, observe: () => undefined };
  let projects: readonly Project[] = [];
  const discovery: ProjectDiscovery = {
    async discover() {
      const found = await deps.discovery.discover();
      projects = found;
      return found;
    },
  };
  return {
    discovery,
    observe(result) {
      try {
        // 接頭辞は伏せるときにだけ要る。エラーの無い更新 (大半) ではキャッシュの一覧を読まない (tracker は一覧の id だけで状態を保つ)。
        const prefixes =
          result.errors.length === 0
            ? new Map<string, readonly string[]>()
            : new Map(readProjectRefs(deps.cache).map((project) => [project.id, project.prefixes]));
        deps.onResult?.(result, projects.map((project) => ({ ...project, prefixes: prefixes.get(project.id) ?? project.prefixes })));
      } catch {
        deps.logError('Refresh result observer failed');
      }
    },
  };
}
