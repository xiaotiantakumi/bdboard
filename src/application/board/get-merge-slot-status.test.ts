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
});
