import { describe, expect, it } from 'vitest';
import {
  BOARD_THRESHOLDS_MAX_ACTIVE_OR_IDLE_MS,
  BOARD_THRESHOLDS_MAX_STALLED_OR_STALE_MS,
  BOARD_THRESHOLDS_MIN_MS,
  resolveBoardThresholds,
  validateBoardThresholds,
} from './board-thresholds.js';
import { DEFAULT_LIVENESS_THRESHOLDS } from './liveness.js';
import { DEFAULT_STALLED_THRESHOLDS } from './stalled.js';

describe('resolveBoardThresholds', () => {
  it('returns default thresholds when overrides are undefined', () => {
    const resolved = resolveBoardThresholds(undefined);
    expect(resolved.stalledThresholds).toEqual(DEFAULT_STALLED_THRESHOLDS);
    expect(resolved.livenessThresholds).toEqual(DEFAULT_LIVENESS_THRESHOLDS);
  });

  it('overrides only the specified fields', () => {
    const customStalled = 12 * 60 * 60_000;
    const resolved = resolveBoardThresholds({ stalledAfterMs: customStalled });
    expect(resolved.stalledThresholds.stalledAfterMs).toBe(customStalled);
    expect(resolved.livenessThresholds).toEqual(DEFAULT_LIVENESS_THRESHOLDS);
  });

  it('can override liveness fields independently', () => {
    // Values intentionally differ from DEFAULT_LIVENESS_THRESHOLDS so this
    // test still catches an override being silently ignored.
    const overrideActiveMs = DEFAULT_LIVENESS_THRESHOLDS.activeMs + 60_000;
    const resolved = resolveBoardThresholds({
      livenessActiveMs: overrideActiveMs,
      livenessStaleMs: 48 * 60 * 60_000,
    });
    expect(resolved.livenessThresholds.activeMs).toBe(overrideActiveMs);
    expect(resolved.livenessThresholds.idleMs).toBe(DEFAULT_LIVENESS_THRESHOLDS.idleMs);
    expect(resolved.livenessThresholds.staleMs).toBe(48 * 60 * 60_000);
    expect(resolved.stalledThresholds).toEqual(DEFAULT_STALLED_THRESHOLDS);
  });
});

describe('validateBoardThresholds', () => {
  it('accepts valid overrides', () => {
    const result = validateBoardThresholds({
      stalledAfterMs: DEFAULT_STALLED_THRESHOLDS.stalledAfterMs,
      livenessActiveMs: DEFAULT_LIVENESS_THRESHOLDS.activeMs,
      livenessIdleMs: DEFAULT_LIVENESS_THRESHOLDS.idleMs,
      livenessStaleMs: DEFAULT_LIVENESS_THRESHOLDS.staleMs,
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('accepts an empty overrides object', () => {
    expect(validateBoardThresholds({})).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1.5],
    ['NaN', Number.NaN],
  ])('rejects %s stalledAfterMs', (_label, value) => {
    const result = validateBoardThresholds({ stalledAfterMs: value });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('滞留判定は正の整数で指定してください');
  });

  it('rejects values below the minimum', () => {
    const result = validateBoardThresholds({ stalledAfterMs: BOARD_THRESHOLDS_MIN_MS - 1 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('滞留判定'))).toBe(true);
  });

  it('rejects stalledAfterMs above the maximum', () => {
    const result = validateBoardThresholds({
      stalledAfterMs: BOARD_THRESHOLDS_MAX_STALLED_OR_STALE_MS + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('滞留判定'))).toBe(true);
  });

  it('rejects livenessActiveMs above the maximum', () => {
    const result = validateBoardThresholds({
      livenessActiveMs: BOARD_THRESHOLDS_MAX_ACTIVE_OR_IDLE_MS + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('liveness active'))).toBe(true);
  });

  it('rejects when active is not shorter than idle after merging defaults', () => {
    const result = validateBoardThresholds({
      livenessActiveMs: DEFAULT_LIVENESS_THRESHOLDS.idleMs,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('liveness active は liveness idle より短くしてください');
  });

  it('rejects when idle is not shorter than stale after merging defaults', () => {
    const result = validateBoardThresholds({
      livenessIdleMs: DEFAULT_LIVENESS_THRESHOLDS.staleMs,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('liveness idle は liveness stale より短くしてください');
  });

  it('rejects an invalid ordering when all three liveness values are provided', () => {
    const result = validateBoardThresholds({
      livenessActiveMs: 60_000,
      livenessIdleMs: 30_000,
      livenessStaleMs: 120_000,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('liveness active は liveness idle より短くしてください');
  });
});
