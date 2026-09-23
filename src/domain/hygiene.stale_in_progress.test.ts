import { describe, expect, it } from 'vitest';
import { checkHygiene } from './hygiene.js';
import { issueKinds, NOW } from './hygiene-test-support.js';
import { DEFAULT_HYGIENE_THRESHOLDS } from './hygiene-thresholds.js';
import { makeTicket } from './test-support.js';

const THRESHOLD_MS = DEFAULT_HYGIENE_THRESHOLDS.staleInProgressAfterMs;
const STALE_ANCHOR = new Date(NOW.getTime() - THRESHOLD_MS);
const ALMOST_STALE_ANCHOR = new Date(NOW.getTime() - THRESHOLD_MS + 1);

describe('checkHygiene stale_in_progress', () => {
  it('flags in_progress tickets older than the default threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-stale',
      status: 'in_progress',
      startedAt: STALE_ANCHOR,
      updatedAt: NOW,
    });

    expect(issueKinds([ticket])).toEqual(['stale_in_progress']);
  });

  it('is false one millisecond before the threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-almost',
      status: 'in_progress',
      startedAt: ALMOST_STALE_ANCHOR,
      updatedAt: NOW,
    });

    expect(issueKinds([ticket])).toEqual([]);
  });

  it('uses updatedAt when startedAt is missing', () => {
    const ticket = makeTicket({
      id: 'bdboard-updated',
      status: 'in_progress',
      updatedAt: STALE_ANCHOR,
    });

    expect(issueKinds([ticket])).toEqual(['stale_in_progress']);
  });

  it('does not flag open tickets', () => {
    const ticket = makeTicket({
      id: 'bdboard-open',
      status: 'open',
      updatedAt: STALE_ANCHOR,
    });

    expect(issueKinds([ticket])).toEqual([]);
  });

  it('respects custom thresholds', () => {
    const ticket = makeTicket({
      id: 'bdboard-custom',
      status: 'in_progress',
      startedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000),
    });

    expect(
      checkHygiene([ticket], {
        now: NOW,
        thresholds: {
          ...DEFAULT_HYGIENE_THRESHOLDS,
          staleInProgressAfterMs: 3 * 24 * 60 * 60_000,
        },
      }).map((issue) => issue.kind),
    ).toEqual([]);

    expect(
      checkHygiene([ticket], {
        now: NOW,
        thresholds: {
          ...DEFAULT_HYGIENE_THRESHOLDS,
          staleInProgressAfterMs: 24 * 60 * 60_000,
        },
      }).map((issue) => issue.kind),
    ).toEqual(['stale_in_progress']);
  });

  it('defaults to seven days', () => {
    expect(DEFAULT_HYGIENE_THRESHOLDS.staleInProgressAfterMs).toBe(
      7 * 24 * 60 * 60_000,
    );
  });

  it('defaults stale pending decision to three days', () => {
    expect(DEFAULT_HYGIENE_THRESHOLDS.stalePendingDecisionAfterMs).toBe(
      3 * 24 * 60 * 60_000,
    );
  });
});
