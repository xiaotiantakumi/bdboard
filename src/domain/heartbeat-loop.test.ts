import { describe, expect, it } from 'vitest';
import { parseHeartbeatLoopCommand } from './heartbeat-loop.js';

describe('parseHeartbeatLoopCommand', () => {
  it('extracts ticket ids from bundled script command lines', () => {
    const parsed = parseHeartbeatLoopCommand(
      'bash /path/bd-heartbeat.sh start --session-pid 4242 --interval 90 --max-hours 12 --repo /repo bdboard-aaa bdboard-bbb',
    );

    expect(parsed.ticketIdCandidates).toEqual(['bdboard-aaa', 'bdboard-bbb']);
    expect(parsed.sessionPidArg).toBe(4242);
  });

  it('extracts ticket ids from hand-written loops with shell punctuation', () => {
    const parsed = parseHeartbeatLoopCommand(
      "bash -c while true; do bd heartbeat bdboard-ccc; sleep 90; done",
    );

    expect(parsed.ticketIdCandidates).toEqual(['bdboard-ccc']);
    expect(parsed.sessionPidArg).toBeUndefined();
  });

  it('accepts dotted sub-ticket ids', () => {
    const parsed = parseHeartbeatLoopCommand(
      'bd heartbeat bdboard-h4xs.13 bdboard-3tw.96',
    );

    expect(parsed.ticketIdCandidates).toEqual(['bdboard-h4xs.13', 'bdboard-3tw.96']);
  });

  it('does not treat flags, paths, or script names as ticket ids', () => {
    const parsed = parseHeartbeatLoopCommand(
      'bash /repo/harness/packs/bdboard-harness/scripts/bd-heartbeat.sh start --session-pid 4242 --repo /repo bdboard-64lx',
    );

    expect(parsed.ticketIdCandidates).toEqual(['bdboard-64lx']);
    expect(parsed.sessionPidArg).toBe(4242);
  });

  it('deduplicates repeated ticket ids while preserving first-seen order', () => {
    const parsed = parseHeartbeatLoopCommand(
      'bd heartbeat bdboard-bbb bdboard-aaa bdboard-bbb',
    );

    expect(parsed.ticketIdCandidates).toEqual(['bdboard-bbb', 'bdboard-aaa']);
  });
});
