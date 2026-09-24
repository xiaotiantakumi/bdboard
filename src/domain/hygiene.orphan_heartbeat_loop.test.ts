import { describe, expect, it } from 'vitest';
import { checkHygiene, type HeartbeatLoopCandidate } from './hygiene.js';
import { NOW } from './hygiene-test-support.js';
import { makeTicket } from './test-support.js';

describe('checkHygiene orphan_heartbeat_loop', () => {
  const repoRoot = '/projects/bdboard';

  function heartbeatLoop(
    overrides: Partial<HeartbeatLoopCandidate> = {},
  ): HeartbeatLoopCandidate {
    return {
      pid: 12_345,
      commandLine:
        'bash /path/bd-heartbeat.sh start --session-pid 4242 --interval 90 --max-hours 12 --repo /repo bdboard-aaa bdboard-bbb',
      ...overrides,
    };
  }

  it('flags loops whose known tickets are all closed', () => {
    const tickets = [
      makeTicket({
        id: 'bdboard-aaa',
        projectId: repoRoot,
        status: 'closed',
        closedAt: NOW,
      }),
      makeTicket({
        id: 'bdboard-bbb',
        projectId: repoRoot,
        status: 'closed',
        closedAt: NOW,
      }),
    ];

    const issues = checkHygiene(tickets, {
      now: NOW,
      heartbeatLoops: [heartbeatLoop()],
    });

    const orphans = issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      kind: 'orphan_heartbeat_loop',
      ticketId: 'bdboard-aaa',
      projectId: repoRoot,
      severity: 'warning',
      heartbeatLoop: {
        pid: 12_345,
        ticketIds: ['bdboard-aaa', 'bdboard-bbb'],
        reason: 'all_closed',
      },
    });
  });

  it('does not flag when at least one known ticket is still open', () => {
    const tickets = [
      makeTicket({
        id: 'bdboard-aaa',
        projectId: repoRoot,
        status: 'closed',
        closedAt: NOW,
      }),
      makeTicket({
        id: 'bdboard-bbb',
        projectId: repoRoot,
        status: 'open',
      }),
    ];

    const issues = checkHygiene(tickets, {
      now: NOW,
      heartbeatLoops: [heartbeatLoop()],
    });

    expect(issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop')).toEqual([]);
  });

  it('does not flag when all known tickets are open', () => {
    const tickets = [
      makeTicket({
        id: 'bdboard-aaa',
        projectId: repoRoot,
        status: 'in_progress',
        startedAt: NOW,
        updatedAt: NOW,
      }),
      makeTicket({
        id: 'bdboard-bbb',
        projectId: repoRoot,
        status: 'open',
      }),
    ];

    const issues = checkHygiene(tickets, {
      now: NOW,
      heartbeatLoops: [heartbeatLoop({ sessionAlive: true, sessionPid: 4242 })],
    });

    expect(issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop')).toEqual([]);
  });

  it('flags session_gone even when tickets remain open', () => {
    const ticket = makeTicket({
      id: 'bdboard-aaa',
      projectId: repoRoot,
      status: 'in_progress',
      startedAt: NOW,
      updatedAt: NOW,
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      heartbeatLoops: [
        heartbeatLoop({
          commandLine:
            'bash /path/bd-heartbeat.sh start --session-pid 4242 --repo /repo bdboard-aaa',
          sessionPid: 4242,
          sessionAlive: false,
        }),
      ],
    });

    const orphans = issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.heartbeatLoop).toMatchObject({
      pid: 12_345,
      ticketIds: ['bdboard-aaa'],
      sessionPid: 4242,
      reason: 'session_gone',
    });
  });

  it('does not flag open tickets when sessionAlive is undefined', () => {
    const ticket = makeTicket({
      id: 'bdboard-aaa',
      projectId: repoRoot,
      status: 'open',
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      heartbeatLoops: [
        heartbeatLoop({
          commandLine: 'bash -c while true; do bd heartbeat bdboard-aaa; sleep 90; done',
        }),
      ],
    });

    expect(issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop')).toEqual([]);
  });

  it('does not flag open tickets when sessionAlive is true', () => {
    const ticket = makeTicket({
      id: 'bdboard-aaa',
      projectId: repoRoot,
      status: 'open',
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      heartbeatLoops: [
        heartbeatLoop({
          commandLine:
            'bash /path/bd-heartbeat.sh start --session-pid 4242 --repo /repo bdboard-aaa',
          sessionPid: 4242,
          sessionAlive: true,
        }),
      ],
    });

    expect(issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop')).toEqual([]);
  });

  it('ignores loops whose ticket ids are absent from the ledger', () => {
    const issues = checkHygiene([], {
      now: NOW,
      heartbeatLoops: [
        heartbeatLoop({
          commandLine: 'bd heartbeat bdboard-unknown',
        }),
      ],
    });

    expect(issues).toEqual([]);
  });

  it('does not flag when a candidate ticket id is unknown to the ledger, even if known ones are all closed', () => {
    const tickets = [
      makeTicket({
        id: 'bdboard-aaa',
        projectId: repoRoot,
        status: 'closed',
        closedAt: NOW,
      }),
    ];
    const issues = checkHygiene(tickets, {
      now: NOW,
      heartbeatLoops: [
        heartbeatLoop({
          commandLine: 'bd heartbeat bdboard-aaa bdboard-unknown',
        }),
      ],
    });
    expect(issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop')).toEqual([]);
  });

  it('copies startedAt from candidate to heartbeatLoop target', () => {
    const tickets = [
      makeTicket({
        id: 'bdboard-aaa',
        projectId: repoRoot,
        status: 'closed',
        closedAt: NOW,
      }),
    ];
    const issues = checkHygiene(tickets, {
      now: NOW,
      heartbeatLoops: [
        heartbeatLoop({
          commandLine: 'bd heartbeat bdboard-aaa',
          startedAt: 'Thu Aug 14 09:12:33 2026',
        }),
      ],
    });
    const orphans = issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.heartbeatLoop?.startedAt).toBe('Thu Aug 14 09:12:33 2026');
  });

  it('emits no orphan_heartbeat_loop when heartbeatLoops is omitted', () => {
    const ticket = makeTicket({
      id: 'bdboard-aaa',
      projectId: repoRoot,
      status: 'closed',
      closedAt: NOW,
    });

    const issues = checkHygiene([ticket], { now: NOW });

    expect(issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop')).toEqual([]);
  });

  it('uses the lexicographically first known ticket as representative and collapses one loop to one row', () => {
    const tickets = [
      makeTicket({
        id: 'bdboard-zzz',
        projectId: repoRoot,
        status: 'closed',
        closedAt: NOW,
      }),
      makeTicket({
        id: 'bdboard-aaa',
        projectId: repoRoot,
        status: 'closed',
        closedAt: NOW,
      }),
    ];

    const issues = checkHygiene(tickets, {
      now: NOW,
      heartbeatLoops: [
        heartbeatLoop({
          commandLine: 'bd heartbeat bdboard-zzz bdboard-aaa',
        }),
      ],
    });

    const orphans = issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.ticketId).toBe('bdboard-aaa');
    expect(orphans[0]?.heartbeatLoop?.ticketIds).toEqual(['bdboard-aaa', 'bdboard-zzz']);
  });

  it('prefers all_closed when both warning conditions match', () => {
    const ticket = makeTicket({
      id: 'bdboard-aaa',
      projectId: repoRoot,
      status: 'closed',
      closedAt: NOW,
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      heartbeatLoops: [
        heartbeatLoop({
          commandLine:
            'bash /path/bd-heartbeat.sh start --session-pid 4242 --repo /repo bdboard-aaa',
          sessionPid: 4242,
          sessionAlive: false,
        }),
      ],
    });

    expect(issues.filter((issue) => issue.kind === 'orphan_heartbeat_loop')[0]?.heartbeatLoop?.reason).toBe(
      'all_closed',
    );
  });
});
