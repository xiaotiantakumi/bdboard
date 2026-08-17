import { describe, expect, it } from 'vitest';
import {
  AI_QUOTA_ALERT_THRESHOLD_MAX_PERCENT,
  AI_QUOTA_ALERT_THRESHOLD_MIN_PERCENT,
  DEFAULT_AI_QUOTA_ALERT_THRESHOLD_PERCENT,
  resolveAiQuotaAlertThresholdPercent,
  validateAiQuotaAlertThresholdPercent,
} from './ai-quota-alert-thresholds.js';

describe('resolveAiQuotaAlertThresholdPercent', () => {
  it('returns default when overrides are undefined', () => {
    expect(resolveAiQuotaAlertThresholdPercent(undefined)).toBe(
      DEFAULT_AI_QUOTA_ALERT_THRESHOLD_PERCENT,
    );
  });

  it('returns override when thresholdPercent is set', () => {
    expect(resolveAiQuotaAlertThresholdPercent({ thresholdPercent: 15 })).toBe(15);
  });
});

describe('validateAiQuotaAlertThresholdPercent', () => {
  it('accepts valid threshold at boundaries', () => {
    expect(validateAiQuotaAlertThresholdPercent(AI_QUOTA_ALERT_THRESHOLD_MIN_PERCENT)).toEqual({
      ok: true,
      errors: [],
    });
    expect(validateAiQuotaAlertThresholdPercent(AI_QUOTA_ALERT_THRESHOLD_MAX_PERCENT)).toEqual({
      ok: true,
      errors: [],
    });
    expect(validateAiQuotaAlertThresholdPercent(DEFAULT_AI_QUOTA_ALERT_THRESHOLD_PERCENT)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1.5],
    ['NaN', Number.NaN],
  ])('rejects %s values', (_label, value) => {
    const result = validateAiQuotaAlertThresholdPercent(value);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('閾値は整数で指定してください');
  });

  it('rejects below minimum', () => {
    const result = validateAiQuotaAlertThresholdPercent(AI_QUOTA_ALERT_THRESHOLD_MIN_PERCENT - 1);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `閾値は${AI_QUOTA_ALERT_THRESHOLD_MIN_PERCENT}%以上にしてください`,
    );
  });

  it('rejects above maximum', () => {
    const result = validateAiQuotaAlertThresholdPercent(AI_QUOTA_ALERT_THRESHOLD_MAX_PERCENT + 1);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `閾値は${AI_QUOTA_ALERT_THRESHOLD_MAX_PERCENT}%以下にしてください`,
    );
  });
});
