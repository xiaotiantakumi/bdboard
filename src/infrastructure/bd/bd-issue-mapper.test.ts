import { describe, expect, it } from 'vitest';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  collectPrefixes,
  mapBdIssueToTicket,
  mapBdListToTickets,
} from './bd-issue-mapper.js';
import type { BdIssue } from './bd-issue-schema.js';

function fullIssue(): BdIssue {
  return {
    id: 'proj-abc',
    title: 'Full issue',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    owner: 'owner@example.com',
    assignee: 'Assignee',
    created_at: '2026-08-14T08:00:00Z',
    created_by: 'Creator',
    updated_at: '2026-08-14T09:00:00Z',
    started_at: '2026-08-14T08:30:00Z',
    closed_at: '2026-08-14T10:00:00Z',
    defer_until: '2026-12-31T00:00:00Z',
    parent: 'proj-parent',
    description: 'desc',
    notes: 'notes',
    labels: ['human', 'needs-review'],
    dependency_count: 1,
    dependent_count: 0,
    comment_count: 0,
    dependencies: [
      {
        issue_id: 'proj-abc',
        depends_on_id: 'proj-blocker',
        type: 'blocks',
      },
      {
        issue_id: 'proj-abc',
        depends_on_id: 'proj-parent',
        type: 'parent-child',
      },
    ],
  };
}

describe('mapBdIssueToTicket', () => {
  it('maps all fields including dates, parentId, and dependencies', () => {
    const ticket = mapBdIssueToTicket(fullIssue(), 'my-project');

    expect(ticket).toEqual({
      id: 'proj-abc',
      projectId: 'my-project',
      title: 'Full issue',
      status: 'open',
      priority: 2,
      issueType: 'task',
      owner: 'owner@example.com',
      assignee: 'Assignee',
      createdAt: new Date('2026-08-14T08:00:00Z'),
      updatedAt: new Date('2026-08-14T09:00:00Z'),
      startedAt: new Date('2026-08-14T08:30:00Z'),
      closedAt: new Date('2026-08-14T10:00:00Z'),
      deferUntil: new Date('2026-12-31T00:00:00Z'),
      parentId: 'proj-parent',
      description: 'desc',
      notes: 'notes',
      labels: ['human', 'needs-review'],
      dependencies: [
        { issueId: 'proj-abc', dependsOnId: 'proj-blocker', kind: 'blocks' },
        { issueId: 'proj-abc', dependsOnId: 'proj-parent', kind: 'parent-child' },
      ],
      commentCount: 0,
    });
  });

  it('returns empty dependencies when dependencies is absent', () => {
    const issue = fullIssue();
    const { dependencies: _removed, ...withoutDeps } = issue;
    const ticket = mapBdIssueToTicket(withoutDeps, 'my-project');

    expect(ticket.dependencies).toEqual([]);
  });

  it('keeps parent-child dependencies', () => {
    const ticket = mapBdIssueToTicket(fullIssue(), 'my-project');
    const parentChild = ticket.dependencies.find((d) => d.kind === 'parent-child');

    expect(parentChild).toEqual({
      issueId: 'proj-abc',
      dependsOnId: 'proj-parent',
      kind: 'parent-child',
    });
  });

  it('throws BdError schema-mismatch for invalid dates', () => {
    const issue = { ...fullIssue(), created_at: 'not-a-date' };

    expect(() => mapBdIssueToTicket(issue, 'my-project')).toThrow(BdError);
    try {
      mapBdIssueToTicket(issue, 'my-project');
    } catch (error) {
      expect(error).toBeInstanceOf(BdError);
      expect((error as BdError).kind).toBe('schema-mismatch');
    }
  });

  it('maps metadata to models when bdboard.model.* keys are present', () => {
    const issue = {
      ...fullIssue(),
      metadata: { 'bdboard.model.implement': 'composer-2.5' },
    };
    const ticket = mapBdIssueToTicket(issue, 'my-project');

    expect(ticket.models).toEqual([{ stage: 'implement', model: 'composer-2.5' }]);
  });

  it('maps bdboard.session metadata to a manual session link', () => {
    const ticket = mapBdIssueToTicket(
      { ...fullIssue(), metadata: { 'bdboard.session': 'sess-manual' } },
      'my-project',
    );

    expect(ticket.manualSessionId).toBe('sess-manual');
  });

  it('omits models when metadata is absent or yields no records', () => {
    const withoutMetadata = mapBdIssueToTicket(fullIssue(), 'my-project');
    expect(withoutMetadata.models).toBeUndefined();

    const emptyMetadata = mapBdIssueToTicket(
      { ...fullIssue(), metadata: {} },
      'my-project',
    );
    expect(emptyMetadata.models).toBeUndefined();
  });

  it('omits labels when the field is absent (older bd output)', () => {
    const issue = fullIssue();
    const { labels: _removed, ...withoutLabels } = issue;
    const ticket = mapBdIssueToTicket(withoutLabels, 'my-project');

    expect(ticket.labels).toBeUndefined();
  });
});

describe('mapBdListToTickets', () => {
  it('throws BdError schema-mismatch when top-level is not an array', () => {
    expect(() => mapBdListToTickets({ id: 'only-id' }, 'my-project')).toThrow(BdError);

    try {
      mapBdListToTickets({ id: 'only-id' }, 'my-project');
    } catch (error) {
      expect(error).toBeInstanceOf(BdError);
      expect((error as BdError).kind).toBe('schema-mismatch');
    }
  });

  it('maps pinned and hooked statuses to tickets', () => {
    for (const status of ['pinned', 'hooked'] as const) {
      const issue = { ...fullIssue(), id: `proj-${status}`, status };
      const { tickets, skipped } = mapBdListToTickets([issue], 'my-project');

      expect(skipped).toEqual([]);
      expect(tickets).toHaveLength(1);
      expect(tickets[0]?.status).toBe(status);
    }
  });

  it('maps all tickets when one row has an unknown custom status', () => {
    const issues = Array.from({ length: 9 }, (_, index) => ({
      ...fullIssue(),
      id: `proj-${index}`,
      status: index === 4 ? 'triaged' : 'open',
    }));

    const { tickets, skipped } = mapBdListToTickets(issues, 'my-project');

    expect(skipped).toEqual([]);
    expect(tickets).toHaveLength(9);
    expect(tickets[4]?.status).toBe('triaged');
  });

  it('skips one invalid row and returns the rest', () => {
    const issues = Array.from({ length: 9 }, (_, index) => {
      if (index === 4) {
        return { id: 'proj-broken' };
      }
      return { ...fullIssue(), id: `proj-${index}` };
    });

    const { tickets, skipped } = mapBdListToTickets(issues, 'my-project');

    expect(tickets).toHaveLength(8);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.index).toBe(4);
    expect(skipped[0]?.id).toBe('proj-broken');
  });

  it('skips invalid row in array instead of failing the whole list', () => {
    const { tickets, skipped } = mapBdListToTickets([{ id: 'only-id' }], 'my-project');

    expect(tickets).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.id).toBe('only-id');
  });

  // bdboard-mwd: `bd merge-slot create` emits a bead with neither owner nor
  // created_by. Requiring them made bdboard drop the row and warn about it.
  it('maps a row that has neither owner nor created_by', () => {
    const { owner: _owner, created_by: _createdBy, ...withoutOwner } = fullIssue();

    const { tickets, skipped } = mapBdListToTickets([withoutOwner], 'my-project');

    expect(skipped).toEqual([]);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.owner).toBeUndefined();
  });

  // bdboard-mwd: bd's own merge-slot bead is not a work ticket. It must be
  // excluded silently — recording it in `skipped` would raise a user-visible
  // warning for a row we deliberately ignore.
  it('excludes gt:slot coordination beads without reporting them as skipped', () => {
    const slot = {
      ...fullIssue(),
      id: 'proj-merge-slot',
      title: 'Merge Slot',
      priority: 0,
      labels: ['gt:slot'],
    };

    const { tickets, skipped } = mapBdListToTickets(
      [slot, { ...fullIssue(), id: 'proj-real' }],
      'my-project',
    );

    expect(skipped).toEqual([]);
    expect(tickets.map((ticket) => ticket.id)).toEqual(['proj-real']);
  });

  it('keeps a ticket whose labels do not mark it as a coordination bead', () => {
    const labelled = { ...fullIssue(), id: 'proj-labelled', labels: ['ui', 'slot'] };

    const { tickets, skipped } = mapBdListToTickets([labelled], 'my-project');

    expect(skipped).toEqual([]);
    expect(tickets.map((ticket) => ticket.id)).toEqual(['proj-labelled']);
  });
});

describe('collectPrefixes', () => {
  it('deduplicates, sorts ascending, and ignores invalid ids', () => {
    const prefixes = collectPrefixes([
      mapBdIssueToTicket({ ...fullIssue(), id: 'bdboard-3tw.10' }, 'p'),
      mapBdIssueToTicket({ ...fullIssue(), id: 'sample-project-86o' }, 'p'),
      mapBdIssueToTicket({ ...fullIssue(), id: 'sample-project-99z' }, 'p'),
      mapBdIssueToTicket({ ...fullIssue(), id: 'invalid' }, 'p'),
    ]);

    expect(prefixes).toEqual(['bdboard', 'sample-project']);
  });
});
