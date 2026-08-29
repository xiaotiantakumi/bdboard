import {
  collectLeftoverCandidates,
  type LeftoverCandidate,
} from '../../domain/git-worktree.js';
import type { Project } from '../../domain/project.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { describeFetchFailures, type FetchFailure } from './fetch-failure-log.js';

const PROJECT_SCAN_CONCURRENCY = 3;

export interface ScanGitLeftoversOptions {
  /** 取得失敗の警告ログ。未指定なら console.warn (discover-projects と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
}

export async function scanGitLeftovers(
  projects: readonly Project[],
  scanner: WorktreeScanner,
  options?: ScanGitLeftoversOptions,
): Promise<readonly LeftoverCandidate[]> {
  const result: LeftoverCandidate[] = [];
  const failures: FetchFailure[] = [];

  await runWithConcurrencyLimit(projects, PROJECT_SCAN_CONCURRENCY, async (project) => {
    try {
      const snapshot = await scanner.scan(project.rootPath);
      result.push(...collectLeftoverCandidates(project.id, project.rootPath, snapshot));
    } catch (error) {
      failures.push({ id: project.id, error });
    }
  });

  if (failures.length > 0) {
    const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    logWarn(
      '[hygiene] could not scan git worktrees for some projects; leftovers there are missing from the panel. ' +
        describeFetchFailures(failures, projects.length),
    );
  }

  return result;
}
