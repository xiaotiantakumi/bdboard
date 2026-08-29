import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
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
  /** 実際に bd を叩いた(listAll に渡した)プロジェクトID。昇順 */
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

  const reused: string[] = [];
  const errors: BdError[] = [];
  const needsRefresh: Project[] = [];
  const fingerprintsByProjectId = new Map<string, string>();

  const sortedProjects = [...discovered].sort((a, b) =>
    compareStrings(a.id, b.id),
  );

  // フィンガープリンタは各プロジェクトのローカルなgit状態を読むだけで安価なため、
  // ここは逐次のままでよい。高コストなのは bd list の shell-out (次段のlistAll) 側。
  for (const project of sortedProjects) {
    try {
      const fingerprint = await deps.fingerprinter.fingerprint(project);
      const cached = deps.cache.getProject(project.id);

      if (cached !== undefined && cached.fingerprint === fingerprint && !force) {
        reused.push(project.id);
        continue;
      }

      fingerprintsByProjectId.set(project.id, fingerprint);
      needsRefresh.push(project);
    } catch (err) {
      errors.push(toBdError(err, project.id));
    }
  }

  const refreshed: string[] = [];

  if (needsRefresh.length > 0) {
    // listAll は内部で並列度制限つきに bd list を実行し、失敗したプロジェクトは
    // 例外を投げずに errors に集める (部分失敗を全体失敗にしない)。個々の
    // ProjectTickets.warnings (壊れた行の読み飛ばし等) も listAll 実装側で
    // errors にまとめ込む契約になっている (bd-cli-issue-repository 参照) ため、
    // ここで二重に result.warnings を errors へ積む必要はない。
    const { results, errors: listAllErrors } = await deps.repository.listAll(needsRefresh);
    errors.push(...listAllErrors);

    for (const result of results) {
      const projectId = result.project.id;
      const fingerprint = fingerprintsByProjectId.get(projectId);
      if (fingerprint === undefined) {
        // listAll には needsRefresh に含めたプロジェクトしか渡していないので
        // 起こらないはずだが、万一未知の project.id が返ってきても cache 破損を
        // 避けるためフィンガープリント無しでは書き込まない。
        continue;
      }

      const cached = deps.cache.getProject(projectId);
      let pendingDecisions = cached?.pendingDecisions;
      if (deps.humanDecisions !== undefined) {
        try {
          pendingDecisions = await deps.humanDecisions.listPendingDecisions(
            result.project.rootPath,
          );
        } catch (err) {
          errors.push(toBdError(err, projectId));
        }
      }

      deps.cache.putProject({
        project: result.project,
        tickets: result.tickets,
        fingerprint,
        fetchedAt: deps.now(),
        ...(pendingDecisions !== undefined ? { pendingDecisions } : {}),
      });
      refreshed.push(projectId);
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
