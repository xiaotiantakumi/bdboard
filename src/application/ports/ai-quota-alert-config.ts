export interface AiQuotaAlertConfig {
  readonly thresholdPercent?: number;
}

export interface AiQuotaAlertConfigPort {
  read(): Promise<AiQuotaAlertConfig | undefined>;
  write(config: AiQuotaAlertConfig): Promise<void>;
}
