import { describe, expect, it } from 'vitest';
import {
  computeWipStatus,
  resolveWipLimitForLane,
  validateWipLimits,
  WIP_LIMIT_MAX,
  WIP_LIMIT_MIN,
} from './wip-limits.js';

describe('resolveWipLimitForLane', () => {
  it('returns undefined when no limits are configured', () => {
    expect(resolveWipLimitForLane(undefined, undefined)).toBeUndefined();
    expect(resolveWipLimitForLane({}, 'proj-a')).toBeUndefined();
  });

  it('returns the global limit for the merged board view', () => {
    expect(resolveWipLimitForLane({ inProgressWipLimit: 5 }, undefined)).toBe(5);
  });

  it('prefers a project override over the global default', () => {
    expect(
      resolveWipLimitForLane(
        { inProgressWipLimit: 5, inProgressWipLimitByProject: { 'proj-a': 3 } },
        'proj-a',
      ),
    ).toBe(3);
  });

  it('falls back to the global limit when no project override exists', () => {
    expect(
      resolveWipLimitForLane(
        { inProgressWipLimit: 5, inProgressWipLimitByProject: { 'proj-b': 3 } },
        'proj-a',
      ),
    ).toBe(5);
  });
});

describe('computeWipStatus', () => {
  it('does not exceed when no limit is configured', () => {
    expect(computeWipStatus(7, undefined)).toEqual({
      limit: undefined,
      count: 7,
      exceeded: false,
    });
  });

  it('does not exceed when count equals the limit', () => {
    expect(computeWipStatus(5, 5)).toEqual({
      limit: 5,
      count: 5,
      exceeded: false,
    });
  });

  it('exceeds when count is above the limit', () => {
    expect(computeWipStatus(7, 5)).toEqual({
      limit: 5,
      count: 7,
      exceeded: true,
    });
  });
});

describe('validateWipLimits', () => {
  it('accepts empty overrides', () => {
    expect(validateWipLimits({})).toEqual({ ok: true, errors: [] });
  });

  it('accepts valid global and project limits', () => {
    expect(
      validateWipLimits({
        inProgressWipLimit: 5,
        inProgressWipLimitByProject: { 'proj-a': 3 },
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1.5],
    ['NaN', Number.NaN],
  ])('rejects %s global limit', (_label, value) => {
    const result = validateWipLimits({ inProgressWipLimit: value });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('In Progress WIP上限(全体)は正の整数で指定してください');
  });

  it('rejects global limits below the minimum', () => {
    const result = validateWipLimits({ inProgressWipLimit: WIP_LIMIT_MIN - 1 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('In Progress WIP上限(全体)'))).toBe(true);
  });

  it('rejects global limits above the maximum', () => {
    const result = validateWipLimits({ inProgressWipLimit: WIP_LIMIT_MAX + 1 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('In Progress WIP上限(全体)'))).toBe(true);
  });

  it('rejects invalid project limit values', () => {
    const result = validateWipLimits({
      inProgressWipLimitByProject: { 'proj-a': 0 },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('proj-a'))).toBe(true);
  });
});
