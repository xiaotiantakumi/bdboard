import type { Project } from '../../domain/project.js';
import { detectStaleLeases, type StaleLeaseIssue } from '../../domain/lease.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { LeaseReader } from '../ports/lease-reader.js';

const PROJECT_SCAN_CONCURRENCY = 3;

export interface GetStaleLeaseIssuesOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
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
    } catch {
      // Skip projects whose reader rejects without failing the whole call.
    }
  });

  issues.sort((a, b) => {
    const projectDiff = a.projectId.localeCompare(b.projectId);
    if (projectDiff !== 0) {
      return projectDiff;
    }
    return a.ticketId.localeCompare(b.ticketId);
  });

  return issues;
}
