import { describe, expect, it } from 'vitest';
import { DEFAULT_HYGIENE_THRESHOLDS } from './hygiene-thresholds.js';
import {
  HYGIENE_HIGH_PRIORITY_MAX,
  HYGIENE_HIGH_PRIORITY_MIN,
  HYGIENE_THRESHOLDS_MAX_MS,
  HYGIENE_THRESHOLDS_MIN_MS,
  resolveHygieneThresholds,
  validateHygieneThresholds,
} from './hygiene-thresholds.js';

describe('resolveHygieneThresholds', () => {
  it('returns defaults when overrides are undefined', () => {
    expect(resolveHygieneThresholds(undefined)).toEqual(DEFAULT_HYGIENE_THRESHOLDS);
  });

  it('applies partial overrides', () => {
    const customStale = 2 * 24 * 60 * 60_000;
    expect(resolveHygieneThresholds({ staleInProgressAfterMs: customStale })).toEqual({
      ...DEFAULT_HYGIENE_THRESHOLDS,
      staleInProgressAfterMs: customStale,
    });
  });

  it('defaults closedWithoutEvidenceWindowMs to seven days', () => {
    expect(DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs).toBe(
      7 * 24 * 60 * 60_000,
    );
  });

  it('applies closedWithoutEvidenceWindowMs override', () => {
    const customWindow = 5 * 24 * 60 * 60_000;
    expect(
      resolveHygieneThresholds({ closedWithoutEvidenceWindowMs: customWindow }),
    ).toEqual({
      ...DEFAULT_HYGIENE_THRESHOLDS,
      closedWithoutEvidenceWindowMs: customWindow,
    });
  });
});

describe('validateHygieneThresholds', () => {
  it('accepts empty overrides', () => {
    expect(validateHygieneThresholds({})).toEqual({ ok: true, errors: [] });
  });

  it('accepts valid ms and priority values', () => {
    expect(
      validateHygieneThresholds({
        staleInProgressAfterMs: HYGIENE_THRESHOLDS_MIN_MS,
        stalePendingDecisionAfterMs: HYGIENE_THRESHOLDS_MAX_MS,
        highPriorityMax: HYGIENE_HIGH_PRIORITY_MAX,
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it('rejects ms below minimum', () => {
    const result = validateHygieneThresholds({
      staleInProgressAfterMs: HYGIENE_THRESHOLDS_MIN_MS - 1,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('in_progress 放置');
  });

  it('rejects priority above maximum', () => {
    const result = validateHygieneThresholds({
      highPriorityMax: HYGIENE_HIGH_PRIORITY_MAX + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('高優先度上限');
  });

  it('rejects non-integer priority', () => {
    const result = validateHygieneThresholds({ highPriorityMax: 1.5 });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('高優先度上限は整数で指定してください');
  });

  it('rejects priority below minimum', () => {
    const result = validateHygieneThresholds({
      highPriorityMax: HYGIENE_HIGH_PRIORITY_MIN - 1,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('高優先度上限');
  });

  it('rejects closedWithoutEvidenceWindowMs below minimum', () => {
    const result = validateHygieneThresholds({
      closedWithoutEvidenceWindowMs: HYGIENE_THRESHOLDS_MIN_MS - 1,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('close 証拠チェック期間');
  });

  it('rejects closedWithoutEvidenceWindowMs above maximum', () => {
    const result = validateHygieneThresholds({
      closedWithoutEvidenceWindowMs: HYGIENE_THRESHOLDS_MAX_MS + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('close 証拠チェック期間');
  });

  it('rejects non-integer closedWithoutEvidenceWindowMs', () => {
    const result = validateHygieneThresholds({
      closedWithoutEvidenceWindowMs: HYGIENE_THRESHOLDS_MIN_MS + 0.5,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('close 証拠チェック期間は整数で指定してください');
  });
});
