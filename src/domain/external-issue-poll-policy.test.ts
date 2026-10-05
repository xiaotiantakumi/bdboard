import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS as BASE,
  EXTERNAL_ISSUE_POLL_MIN_INTERVAL_MS as MIN,
  EXTERNAL_ISSUE_POLL_MAX_INTERVAL_MS as MAX,
  nextExternalIssuePollDelayMs,
  resolveExternalIssuePollIntervalMs,
} from './external-issue-poll-policy.js';

describe('external issue poll policy', () => {
  it('uses the default for non-finite values and clamps and truncates finite values', () => {
    expect(resolveExternalIssuePollIntervalMs(Number.NaN)).toBe(BASE);
    expect(resolveExternalIssuePollIntervalMs(Number.POSITIVE_INFINITY)).toBe(BASE);
    expect([0, -1, 299_999].map(resolveExternalIssuePollIntervalMs)).toEqual([MIN, MIN, MIN]);
    expect(resolveExternalIssuePollIntervalMs(MAX + 1)).toBe(MAX);
    expect(resolveExternalIssuePollIntervalMs(600_000.9)).toBe(600_000);
  });

  it('backs off only selected failures and resets for other results', () => {
    let previous = BASE;
    const delays = [0, 0, 0].map(() => {
      previous = nextExternalIssuePollDelayMs({ baseMs: BASE, previousMs: previous, errorKind: 'failed' });
      return previous;
    });
    expect(delays).toEqual([1_800_000, 3_600_000, 3_600_000]);
    expect(nextExternalIssuePollDelayMs({ baseMs: 7_200_000, previousMs: 7_200_000, errorKind: 'failed' })).toBe(7_200_000);
    for (const errorKind of [null, 'gh-missing', 'gh-unauthenticated', 'bd-failed', 'storage-failed', 'unexpected']) {
      expect(nextExternalIssuePollDelayMs({ baseMs: BASE, previousMs: 3_600_000, errorKind })).toBe(BASE);
    }
  });
});
