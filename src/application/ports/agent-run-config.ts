export interface AgentRunConfig {
  readonly allowRemoteAgentRuns?: boolean;
}

export interface AgentRunConfigPort {
  read(): Promise<AgentRunConfig | undefined>;
  write(config: AgentRunConfig): Promise<void>;
}
