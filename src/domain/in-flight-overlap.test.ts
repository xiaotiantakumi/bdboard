import { describe, expect, it } from 'vitest';
import type { LeftoverCandidate } from './git-worktree.js';
import {
  collectOverlapPeersByTicket,
  computeInFlightOverlaps,
  formatOverlapFiles,
  formatOverlapPeers,
  overlapPeersForTicket,
  selectInFlightWorktrees,
  type InFlightFileEntry,
} from './in-flight-overlap.js';
import type { Status } from './status.js';
import type { Ticket } from './ticket.js';

function entry(
  ticketId: string,
  files: readonly string[],
  projectId = 'p1',
): InFlightFileEntry {
  return { ticketId, projectId, files };
}

function ticket(id: string, status: Status, projectId = 'p1'): Ticket {
  return {
    id,
    projectId,
    title: id,
    status,
    priority: 2,
    issueType: 'task',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    dependencies: [],
    commentCount: 0,
  };
}

function candidate(
  ticketId: string,
  worktreePath: string | null,
  projectId = 'p1',
): LeftoverCandidate {
  return {
    projectId,
    repoRootPath: `/repos/${projectId}`,
    ticketId,
    worktreePath,
    branchName: `bd/${ticketId}`,
  };
}

describe('computeInFlightOverlaps', () => {
  it('returns nothing when no two tickets share a file', () => {
    const overlaps = computeInFlightOverlaps([
      entry('a', ['src/a.ts', 'src/shared-a.ts']),
      entry('b', ['src/b.ts']),
      entry('c', ['src/c.ts']),
    ]);

    expect(overlaps).toEqual([]);
  });

  it('returns one pair with the sorted intersection', () => {
    const overlaps = computeInFlightOverlaps([
      entry('b', ['src/z.ts', 'src/hygiene.ts', 'src/only-b.ts']),
      entry('a', ['src/hygiene.ts', 'src/z.ts', 'src/only-a.ts']),
    ]);

    expect(overlaps).toEqual([
      {
        projectId: 'p1',
        ticketIds: ['a', 'b'],
        files: ['src/hygiene.ts', 'src/z.ts'],
      },
    ]);
  });

  it('returns three pairs for three tickets sharing a file', () => {
    const overlaps = computeInFlightOverlaps([
      entry('c', ['src/hygiene.ts']),
      entry('a', ['src/hygiene.ts']),
      entry('b', ['src/hygiene.ts']),
    ]);

    expect(overlaps.map((overlap) => overlap.ticketIds)).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
    for (const overlap of overlaps) {
      expect(overlap.files).toEqual(['src/hygiene.ts']);
    }
  });

  it('only compares tickets within the same project', () => {
    const overlaps = computeInFlightOverlaps([
      entry('a', ['src/hygiene.ts'], 'p1'),
      entry('b', ['src/hygiene.ts'], 'p2'),
      entry('c', ['src/hygiene.ts'], 'p1'),
    ]);

    expect(overlaps).toEqual([
      {
        projectId: 'p1',
        ticketIds: ['a', 'c'],
        files: ['src/hygiene.ts'],
      },
    ]);
  });

  it('does not pair a ticket with itself when it appears twice', () => {
    const overlaps = computeInFlightOverlaps([
      entry('a', ['src/hygiene.ts']),
      entry('a', ['src/hygiene.ts', 'src/dto.ts']),
    ]);

    expect(overlaps).toEqual([]);
  });

  it('unions files of duplicate entries for the same ticket', () => {
    const overlaps = computeInFlightOverlaps([
      entry('a', ['src/one.ts']),
      entry('a', ['src/two.ts']),
      entry('b', ['src/two.ts']),
    ]);

    expect(overlaps).toEqual([
      { projectId: 'p1', ticketIds: ['a', 'b'], files: ['src/two.ts'] },
    ]);
  });

  it('ignores tickets with no changed files at all', () => {
    const overlaps = computeInFlightOverlaps([
      entry('a', []),
      entry('b', []),
      entry('c', ['']),
    ]);

    expect(overlaps).toEqual([]);
  });

  it('sorts pairs by project then ticket ids', () => {
    const overlaps = computeInFlightOverlaps([
      entry('z', ['f.ts'], 'p2'),
      entry('y', ['f.ts'], 'p2'),
      entry('b', ['f.ts'], 'p1'),
      entry('a', ['f.ts'], 'p1'),
    ]);

    expect(overlaps.map((overlap) => [overlap.projectId, ...overlap.ticketIds])).toEqual([
      ['p1', 'a', 'b'],
      ['p2', 'y', 'z'],
    ]);
  });
});

describe('overlapPeersForTicket', () => {
  it('folds pairs into the other side, sorted, scoped to the project', () => {
    const overlaps = computeInFlightOverlaps([
      entry('b', ['src/x.ts']),
      entry('a', ['src/x.ts', 'src/y.ts']),
      entry('c', ['src/y.ts']),
      entry('a', ['src/x.ts'], 'p2'),
      entry('d', ['src/x.ts'], 'p2'),
    ]);

    expect(overlapPeersForTicket(overlaps, 'p1', 'a')).toEqual([
      { ticketId: 'b', files: ['src/x.ts'] },
      { ticketId: 'c', files: ['src/y.ts'] },
    ]);
    expect(overlapPeersForTicket(overlaps, 'p2', 'a')).toEqual([
      { ticketId: 'd', files: ['src/x.ts'] },
    ]);
    expect(overlapPeersForTicket(overlaps, 'p1', 'unknown')).toEqual([]);
  });
});

describe('formatOverlapFiles', () => {
  it('lists every file when within the limit', () => {
    expect(formatOverlapFiles(['a.ts', 'b.ts'])).toBe('a.ts, b.ts');
  });

  it('caps the list at five files and counts the rest', () => {
    expect(
      formatOverlapFiles(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']),
    ).toBe('a.ts, b.ts, c.ts, d.ts, e.ts (+2)');
  });
});

describe('selectInFlightWorktrees', () => {
  it('keeps worktrees of tickets that are not closed', () => {
    const selected = selectInFlightWorktrees(
      [
        candidate('b', '/wt/b'),
        candidate('a', '/wt/a'),
        candidate('closed', '/wt/closed'),
        candidate('branch-only', null),
        candidate('unknown', '/wt/unknown'),
      ],
      [
        ticket('a', 'in_progress'),
        ticket('b', 'deferred'),
        ticket('closed', 'closed'),
        ticket('branch-only', 'in_progress'),
      ],
    );

    expect(selected).toEqual([
      { projectId: 'p1', ticketId: 'a', worktreePath: '/wt/a' },
      { projectId: 'p1', ticketId: 'b', worktreePath: '/wt/b' },
    ]);
  });

  it('matches tickets per project, not by id alone', () => {
    const selected = selectInFlightWorktrees(
      [candidate('same', '/wt/p1', 'p1'), candidate('same', '/wt/p2', 'p2')],
      [ticket('same', 'in_progress', 'p1'), ticket('same', 'closed', 'p2')],
    );

    expect(selected).toEqual([
      { projectId: 'p1', ticketId: 'same', worktreePath: '/wt/p1' },
    ]);
  });
});

describe('collectOverlapPeersByTicket', () => {
  const overlap = (
    projectId: string,
    ticketIds: readonly [string, string],
    files: readonly string[],
  ) => ({ projectId, ticketIds, files }) as const;

  it('folds every pair a ticket appears in into one group', () => {
    const groups = collectOverlapPeersByTicket([
      overlap('p1', ['a', 'b'], ['x.ts']),
      overlap('p1', ['a', 'c'], ['y.ts', 'z.ts']),
    ]);

    // 2 ペア -> 3 グループ。a は 1 つにまとまり、相手は ID 昇順
    expect(groups).toEqual([
      {
        projectId: 'p1',
        ticketId: 'a',
        peers: [
          { ticketId: 'b', files: ['x.ts'] },
          { ticketId: 'c', files: ['y.ts', 'z.ts'] },
        ],
      },
      { projectId: 'p1', ticketId: 'b', peers: [{ ticketId: 'a', files: ['x.ts'] }] },
      {
        projectId: 'p1',
        ticketId: 'c',
        peers: [{ ticketId: 'a', files: ['y.ts', 'z.ts'] }],
      },
    ]);
  });

  it('keeps same-id tickets of different projects apart', () => {
    const groups = collectOverlapPeersByTicket([
      overlap('p2', ['same', 'other'], ['x.ts']),
      overlap('p1', ['same', 'peer'], ['y.ts']),
    ]);

    expect(groups.map((group) => [group.projectId, group.ticketId])).toEqual([
      ['p1', 'peer'],
      ['p1', 'same'],
      ['p2', 'other'],
      ['p2', 'same'],
    ]);
  });

  it('returns nothing for no overlaps', () => {
    expect(collectOverlapPeersByTicket([])).toEqual([]);
  });
});

describe('formatOverlapPeers', () => {
  it('lists each peer with its own capped file list', () => {
    expect(
      formatOverlapPeers(
        [
          { ticketId: 'bdboard-a', files: ['a.ts', 'b.ts', 'c.ts'] },
          { ticketId: 'bdboard-b', files: ['d.ts'] },
        ],
        2,
      ),
    ).toBe('bdboard-a: a.ts, b.ts (+1); bdboard-b: d.ts');
  });
});
