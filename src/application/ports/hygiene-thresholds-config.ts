export interface HygieneThresholdsConfig {
  readonly staleInProgressAfterMs?: number;
  readonly highPriorityMax?: number;
  readonly stalePendingDecisionAfterMs?: number;
  readonly closedWithoutEvidenceWindowMs?: number;
}

export interface HygieneThresholdsConfigPort {
  read(): Promise<HygieneThresholdsConfig | undefined>;
  write(config: HygieneThresholdsConfig): Promise<void>;
}
