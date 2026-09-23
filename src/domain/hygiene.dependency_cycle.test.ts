import { describe, expect, it } from 'vitest';
import type { DependencyEdge } from './dependency.js';
import { checkHygiene } from './hygiene.js';
import { blocksEdge, NOW } from './hygiene-test-support.js';
import { makeTicket } from './test-support.js';
import type { Ticket } from './ticket.js';

function parentChildEdge(issueId: string, dependsOnId: string): DependencyEdge {
  return { issueId, dependsOnId, kind: 'parent-child' };
}

function dependencyCycleIssues(tickets: readonly Ticket[]) {
  return checkHygiene(tickets, { now: NOW }).filter(
    (issue) => issue.kind === 'dependency_cycle',
  );
}

describe('checkHygiene dependency_cycle', () => {
  it('flags a two-ticket blocks cycle', () => {
    const ticketA = makeTicket({
      id: 'bdboard-cycle-a',
      dependencies: [blocksEdge('bdboard-cycle-a', 'bdboard-cycle-b')],
    });
    const ticketB = makeTicket({
      id: 'bdboard-cycle-b',
      dependencies: [blocksEdge('bdboard-cycle-b', 'bdboard-cycle-a')],
    });

    const issues = dependencyCycleIssues([ticketA, ticketB]);
    expect(issues).toHaveLength(1);

    const issue = issues[0]!;
    expect(issue.kind).toBe('dependency_cycle');
    expect(issue.cycleTicketIds).toEqual(['bdboard-cycle-a', 'bdboard-cycle-b']);
    expect(issue.cycleEdges).toEqual([
      { issueId: 'bdboard-cycle-a', dependsOnId: 'bdboard-cycle-b' },
      { issueId: 'bdboard-cycle-b', dependsOnId: 'bdboard-cycle-a' },
    ]);
    expect(issue.ticketId).toBe('bdboard-cycle-a');
  });

  it('flags a three-ticket blocks cycle', () => {
    const ticketA = makeTicket({
      id: 'bdboard-cycle3-a',
      dependencies: [blocksEdge('bdboard-cycle3-a', 'bdboard-cycle3-c')],
    });
    const ticketB = makeTicket({
      id: 'bdboard-cycle3-b',
      dependencies: [blocksEdge('bdboard-cycle3-b', 'bdboard-cycle3-a')],
    });
    const ticketC = makeTicket({
      id: 'bdboard-cycle3-c',
      dependencies: [blocksEdge('bdboard-cycle3-c', 'bdboard-cycle3-b')],
    });

    const issues = dependencyCycleIssues([ticketA, ticketB, ticketC]);
    expect(issues).toHaveLength(1);

    const issue = issues[0]!;
    expect(issue.cycleTicketIds).toEqual([
      'bdboard-cycle3-a',
      'bdboard-cycle3-b',
      'bdboard-cycle3-c',
    ]);
    expect(issue.cycleEdges).toEqual([
      { issueId: 'bdboard-cycle3-a', dependsOnId: 'bdboard-cycle3-c' },
      { issueId: 'bdboard-cycle3-b', dependsOnId: 'bdboard-cycle3-a' },
      { issueId: 'bdboard-cycle3-c', dependsOnId: 'bdboard-cycle3-b' },
    ]);
  });

  it('does not flag acyclic blocks chains or diamonds', () => {
    const blocker = makeTicket({ id: 'bdboard-chain-a' });
    const middle = makeTicket({
      id: 'bdboard-chain-b',
      dependencies: [blocksEdge('bdboard-chain-b', 'bdboard-chain-a')],
    });
    const leaf = makeTicket({
      id: 'bdboard-chain-c',
      dependencies: [blocksEdge('bdboard-chain-c', 'bdboard-chain-b')],
    });

    expect(dependencyCycleIssues([blocker, middle, leaf])).toEqual([]);

    const diamondTop = makeTicket({ id: 'bdboard-diamond-top' });
    const diamondLeft = makeTicket({
      id: 'bdboard-diamond-left',
      dependencies: [blocksEdge('bdboard-diamond-left', 'bdboard-diamond-top')],
    });
    const diamondRight = makeTicket({
      id: 'bdboard-diamond-right',
      dependencies: [blocksEdge('bdboard-diamond-right', 'bdboard-diamond-top')],
    });
    const diamondBottom = makeTicket({
      id: 'bdboard-diamond-bottom',
      dependencies: [
        blocksEdge('bdboard-diamond-bottom', 'bdboard-diamond-left'),
        blocksEdge('bdboard-diamond-bottom', 'bdboard-diamond-right'),
      ],
    });

    expect(
      dependencyCycleIssues([
        diamondTop,
        diamondLeft,
        diamondRight,
        diamondBottom,
      ]),
    ).toEqual([]);
  });

  it('does not flag parent-child-only cycles', () => {
    const ticketA = makeTicket({
      id: 'bdboard-pc-a',
      dependencies: [parentChildEdge('bdboard-pc-a', 'bdboard-pc-b')],
    });
    const ticketB = makeTicket({
      id: 'bdboard-pc-b',
      dependencies: [parentChildEdge('bdboard-pc-b', 'bdboard-pc-a')],
    });

    expect(dependencyCycleIssues([ticketA, ticketB])).toEqual([]);
  });

  it('reports independent cycles separately', () => {
    const cycle1A = makeTicket({
      id: 'bdboard-dual-1a',
      dependencies: [blocksEdge('bdboard-dual-1a', 'bdboard-dual-1b')],
    });
    const cycle1B = makeTicket({
      id: 'bdboard-dual-1b',
      dependencies: [blocksEdge('bdboard-dual-1b', 'bdboard-dual-1a')],
    });
    const cycle2A = makeTicket({
      id: 'bdboard-dual-2a',
      dependencies: [blocksEdge('bdboard-dual-2a', 'bdboard-dual-2b')],
    });
    const cycle2B = makeTicket({
      id: 'bdboard-dual-2b',
      dependencies: [blocksEdge('bdboard-dual-2b', 'bdboard-dual-2a')],
    });

    const issues = dependencyCycleIssues([cycle1A, cycle1B, cycle2A, cycle2B]);
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.cycleTicketIds)).toEqual([
      ['bdboard-dual-1a', 'bdboard-dual-1b'],
      ['bdboard-dual-2a', 'bdboard-dual-2b'],
    ]);
  });
});
