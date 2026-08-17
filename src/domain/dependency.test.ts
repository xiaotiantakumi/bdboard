import { describe, expect, it } from 'vitest';
import {
  blockingEdges,
  isBlockingKind,
  type DependencyEdge,
} from './dependency.js';

describe('isBlockingKind', () => {
  it('returns true only for blocks', () => {
    expect(isBlockingKind('blocks')).toBe(true);
    expect(isBlockingKind('parent-child')).toBe(false);
    expect(isBlockingKind('related')).toBe(false);
    expect(isBlockingKind('discovered-from')).toBe(false);
    expect(isBlockingKind('unknown-kind')).toBe(false);
  });
});

describe('blockingEdges', () => {
  const edges: readonly DependencyEdge[] = [
    {
      issueId: 'bdboard-3tw.2',
      dependsOnId: 'bdboard-3tw.1',
      kind: 'blocks',
    },
    {
      issueId: 'bdboard-3tw.3',
      dependsOnId: 'bdboard-3tw.1',
      kind: 'parent-child',
    },
    {
      issueId: 'bdboard-3tw.4',
      dependsOnId: 'bdboard-3tw.2',
      kind: 'blocks',
    },
  ];

  it('returns only edges with blocking kind', () => {
    expect(blockingEdges(edges)).toEqual([
      edges[0],
      edges[2],
    ]);
  });

  it('returns empty array when no blocking edges exist', () => {
    expect(
      blockingEdges([
        {
          issueId: 'a-b',
          dependsOnId: 'a-c',
          kind: 'related',
        },
      ]),
    ).toEqual([]);
  });
});
