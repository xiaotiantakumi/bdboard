export const DEFAULT_ALLOW_REMOTE_AGENT_RUNS = false;

export interface AllowRemoteAgentRunsOverrides {
  readonly allowRemoteAgentRuns?: boolean;
}

export function resolveAllowRemoteAgentRuns(
  overrides?: AllowRemoteAgentRunsOverrides,
): boolean {
  const raw = overrides?.allowRemoteAgentRuns;
  if (typeof raw !== 'boolean') {
    return DEFAULT_ALLOW_REMOTE_AGENT_RUNS;
  }
  return raw;
}
