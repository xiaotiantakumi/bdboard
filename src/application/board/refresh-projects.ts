import { compareStrings } from '../../domain/compare.js';
import type { BoardCache } from '../ports/board-cache.js';
import type { HumanDecisionsPort } from '../ports/human-decisions.js';
import { BdError } from '../ports/issue-repository.js';
import type { IssueRepository } from '../ports/issue-repository.js';
import type { ProjectDiscovery } from '../ports/project-discovery.js';
import type { ProjectFingerprinter } from '../ports/project-fingerprinter.js';

export interface RefreshProjectsDeps {
  readonly discovery: ProjectDiscovery;
  readonly repository: IssueRepository;
  readonly fingerprinter: ProjectFingerprinter;
  readonly cache: BoardCache;
  readonly now: () => Date;
  readonly humanDecisions?: HumanDecisionsPort;
}

export interface RefreshResult {
  /** 実際に bd を叩いた(listTickets を呼んだ)プロジェクトID。昇順 */
  readonly refreshed: readonly string[];
  /** キャッシュを再利用したプロジェクトID。昇順 */
  readonly reused: readonly string[];
  /** discovery から消えたのでキャッシュから削除したプロジェクトID。昇順 */
  readonly removed: readonly string[];
  readonly errors: readonly BdError[];
}

export interface RefreshProjectsOptions {
  readonly force?: boolean;
}

function toBdError(err: unknown, projectId: string): BdError {
  if (err instanceof BdError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  return new BdError('unknown', projectId, message);
}

export async function refreshProjects(
  deps: RefreshProjectsDeps,
  options?: RefreshProjectsOptions,
): Promise<RefreshResult> {
  const force = options?.force ?? false;
  const discovered = await deps.discovery.discover();
  const discoveredIds = new Set(discovered.map((project) => project.id));
  const cacheSnapshot = deps.cache.listProjects();

  const refreshed: string[] = [];
  const reused: string[] = [];
  const errors: BdError[] = [];

  const sortedProjects = [...discovered].sort((a, b) =>
    compareStrings(a.id, b.id),
  );

  for (const project of sortedProjects) {
    try {
      const fingerprint = await deps.fingerprinter.fingerprint(project);
      const cached = deps.cache.getProject(project.id);

      if (cached !== undefined && cached.fingerprint === fingerprint && !force) {
        reused.push(project.id);
        continue;
      }

      const result = await deps.repository.listTickets(project);
      if (result.warnings !== undefined) {
        errors.push(...result.warnings);
      }

      let pendingDecisions = cached?.pendingDecisions;
      if (deps.humanDecisions !== undefined) {
        try {
          pendingDecisions = await deps.humanDecisions.listPendingDecisions(
            project.rootPath,
          );
        } catch (err) {
          errors.push(toBdError(err, project.id));
        }
      }

      deps.cache.putProject({
        project: result.project,
        tickets: result.tickets,
        fingerprint,
        fetchedAt: deps.now(),
        ...(pendingDecisions !== undefined ? { pendingDecisions } : {}),
      });
      refreshed.push(project.id);
    } catch (err) {
      errors.push(toBdError(err, project.id));
    }
  }

  const removed: string[] = [];
  for (const entry of cacheSnapshot) {
    if (!discoveredIds.has(entry.project.id)) {
      deps.cache.deleteProject(entry.project.id);
      removed.push(entry.project.id);
    }
  }

  return {
    refreshed: [...refreshed].sort(compareStrings),
    reused: [...reused].sort(compareStrings),
    removed: [...removed].sort(compareStrings),
    errors,
  };
}
