export const DEFAULT_AI_QUOTA_ALERT_THRESHOLD_PERCENT = 20;
export const AI_QUOTA_ALERT_THRESHOLD_MIN_PERCENT = 1;
export const AI_QUOTA_ALERT_THRESHOLD_MAX_PERCENT = 99;

export interface AiQuotaAlertThresholdOverrides {
  readonly thresholdPercent?: number;
}

export function resolveAiQuotaAlertThresholdPercent(
  overrides?: AiQuotaAlertThresholdOverrides,
): number {
  return overrides?.thresholdPercent ?? DEFAULT_AI_QUOTA_ALERT_THRESHOLD_PERCENT;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function validateAiQuotaAlertThresholdPercent(
  value: number,
): { ok: boolean; errors: readonly string[] } {
  const errors: string[] = [];

  if (!isPositiveInteger(value)) {
    errors.push('閾値は整数で指定してください');
  }
  if (value < AI_QUOTA_ALERT_THRESHOLD_MIN_PERCENT) {
    errors.push(`閾値は${AI_QUOTA_ALERT_THRESHOLD_MIN_PERCENT}%以上にしてください`);
  } else if (value > AI_QUOTA_ALERT_THRESHOLD_MAX_PERCENT) {
    errors.push(`閾値は${AI_QUOTA_ALERT_THRESHOLD_MAX_PERCENT}%以下にしてください`);
  }

  return { ok: errors.length === 0, errors };
}
