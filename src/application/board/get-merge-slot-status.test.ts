import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../domain/project.js';
import type { MergeSlotReader } from '../ports/merge-slot-reader.js';
import { getMergeSlotStatus } from './get-merge-slot-status.js';

const NOW = new Date('2026-08-17T11:17:14.000Z');

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    aliasPaths: [],
    prefixes: ['bdboard'],
  };
}

describe('getMergeSlotStatus', () => {
  it('aggregates merge slot status across projects and ignores reader failures', async () => {
    const reader: MergeSlotReader = {
      readMergeSlotSignal: vi.fn(async (rootPath: string) => {
        if (rootPath === '/projects/a') {
          return {
            status: 'in_progress',
            holder: 'session-a',
            updatedAt: '2026-08-17T10:47:14Z',
          };
        }
        if (rootPath === '/projects/b') {
          throw new Error('bd unavailable');
        }
        return null;
      }),
    };

    const statuses = await getMergeSlotStatus(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      reader,
      NOW,
    );

    expect(statuses).toEqual([
      {
        projectId: 'proj-a',
        present: true,
        held: true,
        holder: 'session-a',
        heldSinceIso: '2026-08-17T10:47:14Z',
        heldForMs: 30 * 60_000,
        isLongHeld: false,
      },
    ]);
  });

  it('filters by projectIds when provided', async () => {
    const reader: MergeSlotReader = {
      readMergeSlotSignal: vi.fn(async () => ({
        status: 'open',
        holder: null,
        updatedAt: '2026-08-17T10:48:26Z',
      })),
    };

    const statuses = await getMergeSlotStatus(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      reader,
      NOW,
      { projectIds: ['proj-b'] },
    );

    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.projectId).toBe('proj-b');
    expect(statuses[0]?.present).toBe(true);
    expect(statuses[0]?.held).toBe(false);
  });

  it('propagates held holder from the reader', async () => {
    const reader: MergeSlotReader = {
      readMergeSlotSignal: vi.fn(async () => ({
        status: 'in_progress',
        holder: 'session-merge-holder',
        updatedAt: '2026-08-17T10:00:00.000Z',
      })),
    };

    const statuses = await getMergeSlotStatus(
      [project('proj-a', '/projects/a')],
      reader,
      NOW,
    );

    expect(statuses[0]).toMatchObject({
      held: true,
      holder: 'session-merge-holder',
      isLongHeld: true,
    });
  });

  it('limits project scan concurrency to the configured maximum', async () => {
    const projects = Array.from({ length: 8 }, (_, index) =>
      project(`proj-${index}`, `/projects/${index}`),
    );

    let activeCount = 0;
    let maxObserved = 0;

    const reader: MergeSlotReader = {
      readMergeSlotSignal: vi.fn(async () => {
        activeCount += 1;
        maxObserved = Math.max(maxObserved, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCount -= 1;
        return {
          status: 'open',
          holder: null,
          updatedAt: '2026-08-17T10:48:26Z',
        };
      }),
    };

    const statuses = await getMergeSlotStatus(projects, reader, NOW);

    expect(statuses).toHaveLength(8);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(1);
  });

  it('logs a warning when some projects fail but continues with the rest', async () => {
    const reader: MergeSlotReader = {
      readMergeSlotSignal: vi.fn(async (rootPath: string) => {
        if (rootPath === '/projects/a') {
          return {
            status: 'in_progress',
            holder: 'session-a',
            updatedAt: '2026-08-17T10:47:14Z',
          };
        }
        if (rootPath === '/projects/b') {
          throw new Error('bd unavailable');
        }
        return null;
      }),
    };

    const logWarn = vi.fn();
    const statuses = await getMergeSlotStatus(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      reader,
      NOW,
      { logWarn },
    );

    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.projectId).toBe('proj-a');
    expect(logWarn).toHaveBeenCalledTimes(1);
    const message = logWarn.mock.calls[0]?.[0] as string;
    expect(message).toContain('1 of 2 failed');
    expect(message).toContain('proj-b');
    expect(message).toContain('bd unavailable');
  });
});
