export interface BoardThresholdsConfig {
  readonly stalledAfterMs?: number;
  readonly livenessActiveMs?: number;
  readonly livenessIdleMs?: number;
  readonly livenessStaleMs?: number;
}

export interface BoardThresholdsConfigPort {
  read(): Promise<BoardThresholdsConfig | undefined>;
  write(config: BoardThresholdsConfig): Promise<void>;
}
