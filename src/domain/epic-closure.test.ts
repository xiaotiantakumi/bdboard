import { describe, expect, it } from 'vitest';
import { makeTicket } from './test-support.js';
import { filterTicketsByEpic } from './epic-closure.js';

describe('filterTicketsByEpic', () => {
  it('includes the epic and all recursive parent-child descendants, but not blocks edges', () => {
    const tickets = [
      makeTicket({ id: 'epic' }),
      makeTicket({ id: 'child', parentId: 'epic' }),
      makeTicket({ id: 'grandchild', parentId: 'child' }),
      makeTicket({
        id: 'blocked',
        dependencies: [{ issueId: 'blocked', dependsOnId: 'grandchild', kind: 'blocks' }],
      }),
      makeTicket({ id: 'other' }),
    ];

    expect(filterTicketsByEpic('epic', tickets).map((ticket) => ticket.id)).toEqual([
      'epic',
      'child',
      'grandchild',
    ]);
  });

  it('terminates on malformed cyclic parent-child data', () => {
    const tickets = [
      makeTicket({ id: 'epic', parentId: 'child' }),
      makeTicket({ id: 'child', parentId: 'epic' }),
    ];

    expect(filterTicketsByEpic('epic', tickets).map((ticket) => ticket.id)).toEqual([
      'epic',
      'child',
    ]);
  });
});
