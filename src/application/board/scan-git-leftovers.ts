import {
  collectLeftoverCandidates,
  type LeftoverCandidate,
} from '../../domain/git-worktree.js';
import type { Project } from '../../domain/project.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';

export async function scanGitLeftovers(
  projects: readonly Project[],
  scanner: WorktreeScanner,
): Promise<readonly LeftoverCandidate[]> {
  const settled = await Promise.allSettled(
    projects.map(async (project) => {
      const snapshot = await scanner.scan(project.rootPath);
      return collectLeftoverCandidates(project.id, project.rootPath, snapshot);
    }),
  );

  const result: LeftoverCandidate[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      result.push(...outcome.value);
    }
  }

  return result;
}
