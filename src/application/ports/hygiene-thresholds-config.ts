export interface HygieneThresholdsConfig {
  readonly staleInProgressAfterMs?: number;
  readonly highPriorityMax?: number;
  readonly stalePendingDecisionAfterMs?: number;
}

export interface HygieneThresholdsConfigPort {
  read(): Promise<HygieneThresholdsConfig | undefined>;
  write(config: HygieneThresholdsConfig): Promise<void>;
}
