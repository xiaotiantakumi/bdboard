import { describe, expect, it } from 'vitest';
import { issueKinds, issuesFor, NOW } from './hygiene-test-support.js';
import { makeTicket } from './test-support.js';

describe('checkHygiene unblocked_high_priority_idle', () => {
  it('flags ready high-priority tickets whose blockers are all closed', () => {
    const blocker = makeTicket({
      id: 'bdboard-blocker',
      status: 'closed',
      closedAt: NOW,
    });
    const ticket = makeTicket({
      id: 'bdboard-ready',
      status: 'open',
      priority: 0,
      dependencies: [
        { issueId: 'bdboard-ready', dependsOnId: 'bdboard-blocker', kind: 'blocks' },
      ],
    });

    expect(issueKinds([blocker, ticket])).toContain('unblocked_high_priority_idle');
  });

  it('does not flag when an open blocker remains', () => {
    const blocker = makeTicket({ id: 'bdboard-blocker', status: 'open' });
    const ticket = makeTicket({
      id: 'bdboard-blocked',
      status: 'open',
      priority: 0,
      dependencies: [
        { issueId: 'bdboard-blocked', dependsOnId: 'bdboard-blocker', kind: 'blocks' },
      ],
    });

    expect(issuesFor('bdboard-blocked', [blocker, ticket])).toEqual([]);
  });

  it('does not flag low-priority tickets', () => {
    const blocker = makeTicket({
      id: 'bdboard-blocker',
      status: 'closed',
      closedAt: NOW,
    });
    const ticket = makeTicket({
      id: 'bdboard-low',
      status: 'open',
      priority: 2,
      dependencies: [
        { issueId: 'bdboard-low', dependsOnId: 'bdboard-blocker', kind: 'blocks' },
      ],
    });

    expect(issuesFor('bdboard-low', [blocker, ticket])).toEqual([]);
  });

  it('does not flag tickets without blocking dependencies', () => {
    const ticket = makeTicket({
      id: 'bdboard-plain',
      status: 'open',
      priority: 0,
    });

    expect(issuesFor('bdboard-plain', [ticket])).toEqual([]);
  });

  it('does not flag in_progress tickets', () => {
    const blocker = makeTicket({
      id: 'bdboard-blocker',
      status: 'closed',
      closedAt: NOW,
    });
    const ticket = makeTicket({
      id: 'bdboard-working',
      status: 'in_progress',
      priority: 0,
      updatedAt: NOW,
      startedAt: NOW,
      dependencies: [
        {
          issueId: 'bdboard-working',
          dependsOnId: 'bdboard-blocker',
          kind: 'blocks',
        },
      ],
    });

    expect(
      issuesFor('bdboard-working', [blocker, ticket]).filter(
        (issue) => issue.kind === 'unblocked_high_priority_idle',
      ),
    ).toEqual([]);
  });
});
