import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../domain/project.js';
import type { LeaseReader } from '../ports/lease-reader.js';
import { getStaleLeaseIssues } from './get-stale-lease-issues.js';

const NOW = new Date('2026-08-16T10:00:00.000Z');

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    aliasPaths: [],
    prefixes: ['bdboard'],
  };
}

describe('getStaleLeaseIssues', () => {
  it('aggregates stale leases across projects and ignores reader failures', async () => {
    const reader: LeaseReader = {
      listInProgressWithLease: vi.fn(async (rootPath: string) => {
        if (rootPath === '/projects/a') {
          return [
            {
              id: 'bdboard-stale',
              leaseExpiresAt: '2026-08-16T09:55:00.000Z',
              heartbeatAt: '2026-08-16T09:50:00.000Z',
            },
          ];
        }
        if (rootPath === '/projects/b') {
          throw new Error('bd unavailable');
        }
        return [];
      }),
    };

    const issues = await getStaleLeaseIssues(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      reader,
      NOW,
    );

    expect(issues).toEqual([
      {
        ticketId: 'bdboard-stale',
        projectId: 'proj-a',
        leaseExpiresAt: '2026-08-16T09:55:00.000Z',
        staleForMs: 5 * 60_000,
      },
    ]);
  });

  it('filters by projectIds when provided', async () => {
    const reader: LeaseReader = {
      listInProgressWithLease: vi.fn(async () => [
        {
          id: 'bdboard-stale',
          leaseExpiresAt: '2026-08-16T09:55:00.000Z',
          heartbeatAt: '2026-08-16T09:50:00.000Z',
        },
      ]),
    };

    const issues = await getStaleLeaseIssues(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      reader,
      NOW,
      { projectIds: ['proj-b'] },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.projectId).toBe('proj-b');
  });
});
