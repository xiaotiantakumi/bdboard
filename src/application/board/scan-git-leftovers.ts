import {
  collectLeftoverCandidates,
  type LeftoverCandidate,
} from '../../domain/git-worktree.js';
import type { Project } from '../../domain/project.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';

const PROJECT_SCAN_CONCURRENCY = 3;

export async function scanGitLeftovers(
  projects: readonly Project[],
  scanner: WorktreeScanner,
): Promise<readonly LeftoverCandidate[]> {
  const result: LeftoverCandidate[] = [];

  await runWithConcurrencyLimit(projects, PROJECT_SCAN_CONCURRENCY, async (project) => {
    try {
      const snapshot = await scanner.scan(project.rootPath);
      result.push(...collectLeftoverCandidates(project.id, project.rootPath, snapshot));
    } catch {
      // Skip projects whose scan rejects without failing the whole call.
    }
  });

  return result;
}
