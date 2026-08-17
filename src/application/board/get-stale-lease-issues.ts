import type { Project } from '../../domain/project.js';
import { detectStaleLeases, type StaleLeaseIssue } from '../../domain/lease.js';
import type { LeaseReader } from '../ports/lease-reader.js';

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

  const settled = await Promise.allSettled(
    targetProjects.map(async (project) => {
      const tickets = await reader.listInProgressWithLease(project.rootPath);
      return detectStaleLeases(
        tickets.map((ticket) => ({
          id: ticket.id,
          leaseExpiresAt: ticket.leaseExpiresAt,
          heartbeatAt: ticket.heartbeatAt,
        })),
        project.id,
        now,
      );
    }),
  );

  const issues: StaleLeaseIssue[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      issues.push(...outcome.value);
    }
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
