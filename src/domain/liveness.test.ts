import { describe, expect, it } from 'vitest';
import {
  computeLiveness,
  DEFAULT_LIVENESS_THRESHOLDS,
  livenessRank,
  type Liveness,
} from './liveness.js';
import { makeSession } from './test-support.js';

const BASE = new Date('2026-01-01T00:00:00.000Z');
const { activeMs, idleMs, staleMs } = DEFAULT_LIVENESS_THRESHOLDS;

function atOffset(ms: number): Date {
  return new Date(BASE.getTime() + ms);
}

describe('DEFAULT_LIVENESS_THRESHOLDS', () => {
  // Regression guard for bdboard-3tw.37: this is a product decision, not a
  // structural invariant, so nothing else here would catch it reverting.
  it('sets the active threshold to 5 minutes', () => {
    expect(DEFAULT_LIVENESS_THRESHOLDS.activeMs).toBe(5 * 60_000);
  });
});

describe('computeLiveness', () => {
  it('returns dormant when session is not alive regardless of age', () => {
    const session = makeSession({
      alive: false,
      lastActivityAt: BASE,
    });
    expect(computeLiveness(BASE, session)).toBe('dormant');
    expect(computeLiveness(atOffset(staleMs + 1), session)).toBe('dormant');
  });

  it('returns active at exactly activeMs boundary', () => {
    const session = makeSession({ lastActivityAt: BASE });
    expect(computeLiveness(atOffset(activeMs), session)).toBe('active');
  });

  it('returns idle at activeMs + 1', () => {
    const session = makeSession({ lastActivityAt: BASE });
    expect(computeLiveness(atOffset(activeMs + 1), session)).toBe('idle');
  });

  it('returns idle at exactly idleMs boundary', () => {
    const session = makeSession({ lastActivityAt: BASE });
    expect(computeLiveness(atOffset(idleMs), session)).toBe('idle');
  });

  it('returns stale at idleMs + 1', () => {
    const session = makeSession({ lastActivityAt: BASE });
    expect(computeLiveness(atOffset(idleMs + 1), session)).toBe('stale');
  });

  it('returns stale at exactly staleMs boundary', () => {
    const session = makeSession({ lastActivityAt: BASE });
    expect(computeLiveness(atOffset(staleMs), session)).toBe('stale');
  });

  it('returns dormant at staleMs + 1', () => {
    const session = makeSession({ lastActivityAt: BASE });
    expect(computeLiveness(atOffset(staleMs + 1), session)).toBe('dormant');
  });

  it('clamps negative age to active when lastActivityAt is in the future', () => {
    const session = makeSession({
      lastActivityAt: atOffset(60_000),
    });
    expect(computeLiveness(BASE, session)).toBe('active');
  });

  it('uses custom thresholds when provided', () => {
    const session = makeSession({ lastActivityAt: BASE });
    const thresholds = { activeMs: 100, idleMs: 200, staleMs: 300 };

    expect(computeLiveness(atOffset(100), session, thresholds)).toBe('active');
    expect(computeLiveness(atOffset(101), session, thresholds)).toBe('idle');
    expect(computeLiveness(atOffset(200), session, thresholds)).toBe('idle');
    expect(computeLiveness(atOffset(201), session, thresholds)).toBe('stale');
    expect(computeLiveness(atOffset(300), session, thresholds)).toBe('stale');
    expect(computeLiveness(atOffset(301), session, thresholds)).toBe('dormant');
  });
});

describe('livenessRank', () => {
  it.each<[Liveness, number]>([
    ['active', 0],
    ['idle', 1],
    ['stale', 2],
    ['dormant', 3],
  ])('returns %i for %s', (liveness, expected) => {
    expect(livenessRank(liveness)).toBe(expected);
  });
});
