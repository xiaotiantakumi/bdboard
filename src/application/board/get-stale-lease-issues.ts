import type { Project } from '../../domain/project.js';
import { detectStaleLeases, type StaleLeaseIssue } from '../../domain/lease.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { LeaseReader } from '../ports/lease-reader.js';
import { describeFetchFailures, type FetchFailure } from './fetch-failure-log.js';

const PROJECT_SCAN_CONCURRENCY = 3;

export interface GetStaleLeaseIssuesOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  /** 取得失敗の警告ログ。未指定なら console.warn (discover-projects と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
}

export async function getStaleLeaseIssues(
  projects: readonly Project[],
  reader: LeaseReader,
  now: Date,
  options?: GetStaleLeaseIssuesOptions,
): Promise<readonly StaleLeaseIssue[]> {
  let targetProjects = projects;
  if (options?.projectIds !== undefined) {
    const filterSet = new Set(options.projectIds);
    targetProjects = projects.filter((project) => filterSet.has(project.id));
  }

  const issues: StaleLeaseIssue[] = [];
  const failures: FetchFailure[] = [];

  await runWithConcurrencyLimit(targetProjects, PROJECT_SCAN_CONCURRENCY, async (project) => {
    try {
      const tickets = await reader.listInProgressWithLease(project.rootPath);
      issues.push(
        ...detectStaleLeases(
          tickets.map((ticket) => ({
            id: ticket.id,
            leaseExpiresAt: ticket.leaseExpiresAt,
            heartbeatAt: ticket.heartbeatAt,
          })),
          project.id,
          now,
        ),
      );
    } catch (error) {
      failures.push({ id: project.id, error });
    }
  });

  if (failures.length > 0) {
    const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    logWarn(
      '[hygiene] could not read lease info for some projects; stale leases there are missing from the panel. ' +
        describeFetchFailures(failures, targetProjects.length),
    );
  }

  issues.sort((a, b) => {
    const projectDiff = a.projectId.localeCompare(b.projectId);
    if (projectDiff !== 0) {
      return projectDiff;
    }
    return a.ticketId.localeCompare(b.ticketId);
  });

  return issues;
}
