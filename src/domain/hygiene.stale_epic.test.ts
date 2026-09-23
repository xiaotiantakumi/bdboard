import { describe, expect, it } from 'vitest';
import { issueKinds, issuesFor, NOW } from './hygiene-test-support.js';
import { makeTicket } from './test-support.js';

describe('checkHygiene stale_epic', () => {
  it('flags an open parent when all direct children are closed', () => {
    const epic = makeTicket({ id: 'bdboard-epic', status: 'open' });
    const child = makeTicket({
      id: 'bdboard-child',
      parentId: 'bdboard-epic',
      status: 'closed',
      closedAt: NOW,
    });

    expect(issueKinds([epic, child])).toContain('stale_epic');
    expect(issuesFor('bdboard-epic', [epic, child])[0]?.kind).toBe('stale_epic');
  });

  it('does not flag when some children remain open', () => {
    const epic = makeTicket({ id: 'bdboard-epic', status: 'open' });
    const done = makeTicket({
      id: 'bdboard-done',
      parentId: 'bdboard-epic',
      status: 'closed',
      closedAt: NOW,
    });
    const open = makeTicket({
      id: 'bdboard-open',
      parentId: 'bdboard-epic',
      status: 'open',
    });

    expect(issuesFor('bdboard-epic', [epic, done, open])).toEqual([]);
  });

  it('does not flag parents with zero children', () => {
    const epic = makeTicket({ id: 'bdboard-epic', status: 'open' });

    expect(issuesFor('bdboard-epic', [epic])).toEqual([]);
  });

  it('does not flag closed parents even when all children are closed', () => {
    const epic = makeTicket({
      id: 'bdboard-epic',
      status: 'closed',
      closedAt: NOW,
    });
    const child = makeTicket({
      id: 'bdboard-child',
      parentId: 'bdboard-epic',
      status: 'closed',
      closedAt: NOW,
    });

    expect(
      issuesFor('bdboard-epic', [epic, child]).filter(
        (issue) => issue.kind === 'stale_epic',
      ),
    ).toEqual([]);
  });
});
