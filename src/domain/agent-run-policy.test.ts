import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOW_REMOTE_AGENT_RUNS,
  resolveAllowRemoteAgentRuns,
} from './agent-run-policy.js';

describe('resolveAllowRemoteAgentRuns', () => {
  it('returns default when overrides are undefined', () => {
    expect(resolveAllowRemoteAgentRuns(undefined)).toBe(DEFAULT_ALLOW_REMOTE_AGENT_RUNS);
  });

  it('returns default when allowRemoteAgentRuns is missing', () => {
    expect(resolveAllowRemoteAgentRuns({})).toBe(DEFAULT_ALLOW_REMOTE_AGENT_RUNS);
  });

  it('returns default when allowRemoteAgentRuns is not a boolean', () => {
    expect(
      resolveAllowRemoteAgentRuns({ allowRemoteAgentRuns: 'true' as unknown as boolean }),
    ).toBe(DEFAULT_ALLOW_REMOTE_AGENT_RUNS);
    expect(
      resolveAllowRemoteAgentRuns({ allowRemoteAgentRuns: 1 as unknown as boolean }),
    ).toBe(DEFAULT_ALLOW_REMOTE_AGENT_RUNS);
  });

  it('returns override when allowRemoteAgentRuns is a boolean', () => {
    expect(resolveAllowRemoteAgentRuns({ allowRemoteAgentRuns: true })).toBe(true);
    expect(resolveAllowRemoteAgentRuns({ allowRemoteAgentRuns: false })).toBe(false);
  });
});
