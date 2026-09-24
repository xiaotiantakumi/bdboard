import { describe, expect, it } from 'vitest';
import { checkHygiene } from './hygiene.js';
import { NOW } from './hygiene-test-support.js';
import { makeTicket } from './test-support.js';
import type { Ticket } from './ticket.js';

describe('checkHygiene aggregation', () => {
  it('returns deterministic sorted issues across projects', () => {
    const a = makeTicket({
      id: 'bdboard-a',
      projectId: '/a',
      status: 'deferred',
      deferUntil: new Date(NOW.getTime() - 1),
    });
    const b = makeTicket({
      id: 'bdboard-b',
      projectId: '/b',
      priority: undefined as unknown as Ticket['priority'],
    });

    const first = checkHygiene([b, a], { now: NOW });
    const second = checkHygiene([a, b], { now: NOW });
    expect(second).toEqual(first);
  });
});
