import { describe, expect, it } from 'vitest';
import type { DependencyEdge } from './dependency.js';
import { buildDirectChildrenIndex, epicProgress } from './epic-progress.js';
import { makeTicket } from './test-support.js';

function parentChildEdge(issueId: string, dependsOnId: string): DependencyEdge {
  return { issueId, dependsOnId, kind: 'parent-child' };
}

describe('epicProgress', () => {
  it('returns null when the parent has no direct children', () => {
    const parent = makeTicket({ id: 'bdboard-parent' });
    const orphan = makeTicket({ id: 'bdboard-other' });

    expect(epicProgress('bdboard-parent', [parent, orphan])).toBeNull();
  });

  it('counts partial completion via parentId and parent-child edges', () => {
    const parent = makeTicket({ id: 'bdboard-epic' });
    const doneByParentId = makeTicket({
      id: 'bdboard-done-a',
      parentId: 'bdboard-epic',
      status: 'closed',
    });
    const openByEdge = makeTicket({
      id: 'bdboard-open-b',
      status: 'open',
      dependencies: [parentChildEdge('bdboard-open-b', 'bdboard-epic')],
    });
    const openByParentId = makeTicket({
      id: 'bdboard-open-c',
      parentId: 'bdboard-epic',
      status: 'in_progress',
    });

    expect(
      epicProgress('bdboard-epic', [
        parent,
        doneByParentId,
        openByEdge,
        openByParentId,
      ]),
    ).toEqual({ total: 3, done: 1 });
  });

  it('returns done equal to total when every direct child is closed', () => {
    const parent = makeTicket({ id: 'bdboard-epic' });
    const childA = makeTicket({
      id: 'bdboard-child-a',
      parentId: 'bdboard-epic',
      status: 'closed',
    });
    const childB = makeTicket({
      id: 'bdboard-child-b',
      dependencies: [parentChildEdge('bdboard-child-b', 'bdboard-epic')],
      status: 'closed',
    });

    const progress = epicProgress('bdboard-epic', [parent, childA, childB]);
    expect(progress).toEqual({ total: 2, done: 2 });
  });

  it('counts only direct children when grandchildren exist', () => {
    const epic = makeTicket({ id: 'bdboard-epic' });
    const child = makeTicket({
      id: 'bdboard-child',
      parentId: 'bdboard-epic',
      status: 'open',
    });
    const grandchild = makeTicket({
      id: 'bdboard-grandchild',
      parentId: 'bdboard-child',
      status: 'closed',
      dependencies: [parentChildEdge('bdboard-grandchild', 'bdboard-child')],
    });

    expect(epicProgress('bdboard-epic', [epic, child, grandchild])).toEqual({
      total: 1,
      done: 0,
    });
    expect(epicProgress('bdboard-child', [epic, child, grandchild])).toEqual({
      total: 1,
      done: 1,
    });
  });

  it('deduplicates a child linked by both parentId and parent-child edge', () => {
    const parent = makeTicket({ id: 'bdboard-epic' });
    const child = makeTicket({
      id: 'bdboard-child',
      parentId: 'bdboard-epic',
      status: 'closed',
      dependencies: [parentChildEdge('bdboard-child', 'bdboard-epic')],
    });

    expect(epicProgress('bdboard-epic', [parent, child])).toEqual({
      total: 1,
      done: 1,
    });
  });
});

describe('buildDirectChildrenIndex', () => {
  it('indexes direct children from parentId and parent-child edges', () => {
    const parent = makeTicket({ id: 'bdboard-epic' });
    const byParentId = makeTicket({
      id: 'bdboard-a',
      parentId: 'bdboard-epic',
    });
    const byEdge = makeTicket({
      id: 'bdboard-b',
      dependencies: [parentChildEdge('bdboard-b', 'bdboard-epic')],
    });

    const index = buildDirectChildrenIndex([parent, byParentId, byEdge]);
    expect(index.get('bdboard-epic')?.slice().sort()).toEqual([
      'bdboard-a',
      'bdboard-b',
    ]);
  });
});
