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

  it('limits project scan concurrency to the configured maximum', async () => {
    const projects = Array.from({ length: 8 }, (_, index) =>
      project(`proj-${index}`, `/projects/${index}`),
    );

    let activeCount = 0;
    let maxObserved = 0;

    const reader: LeaseReader = {
      listInProgressWithLease: vi.fn(async () => {
        activeCount += 1;
        maxObserved = Math.max(maxObserved, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCount -= 1;
        return [
          {
            id: 'bdboard-stale',
            leaseExpiresAt: '2026-08-16T09:55:00.000Z',
            heartbeatAt: '2026-08-16T09:50:00.000Z',
          },
        ];
      }),
    };

    const issues = await getStaleLeaseIssues(projects, reader, NOW);

    expect(issues).toHaveLength(8);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(1);
  });

  it('logs a warning when some projects fail but continues with the rest', async () => {
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

    const logWarn = vi.fn();
    const issues = await getStaleLeaseIssues(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      reader,
      NOW,
      { logWarn },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.projectId).toBe('proj-a');
    expect(logWarn).toHaveBeenCalledTimes(1);
    const message = logWarn.mock.calls[0]?.[0] as string;
    expect(message).toContain('1 of 2 failed');
    expect(message).toContain('proj-b');
    expect(message).toContain('bd unavailable');
  });
});
