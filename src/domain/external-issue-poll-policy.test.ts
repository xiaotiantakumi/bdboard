import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_ISSUE_GH_CALLS_PER_HOUR,
  EXTERNAL_ISSUE_GH_CALL_WINDOW_MS,
  EXTERNAL_ISSUE_GH_MAX_PAGES,
  EXTERNAL_ISSUE_POLL_BACKOFF_CAP_MS,
  EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS,
  EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS,
  EXTERNAL_ISSUE_POLL_MAX_INTERVAL_MS,
  EXTERNAL_ISSUE_POLL_MIN_INTERVAL_MS,
  EXTERNAL_ISSUE_REFRESH_MIN_GAP_MS,
  nextExternalIssuePollDelayMs,
  resolveExternalIssuePollIntervalMs,
} from './external-issue-poll-policy.js';

describe('the numbers the ticket fixes (bdboard-4y8q.9.4)', () => {
  it('pins the default, the floor, the first delay, the backoff cap, the refresh gap and the gh budget', () => {
    expect(EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS).toBe(900_000);
    expect(EXTERNAL_ISSUE_POLL_MIN_INTERVAL_MS).toBe(300_000);
    expect(EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS).toBe(60_000);
    expect(EXTERNAL_ISSUE_POLL_BACKOFF_CAP_MS).toBe(3_600_000);
    expect(EXTERNAL_ISSUE_REFRESH_MIN_GAP_MS).toBe(60_000);
    expect(EXTERNAL_ISSUE_GH_CALLS_PER_HOUR).toBe(12);
    expect(EXTERNAL_ISSUE_GH_CALL_WINDOW_MS).toBe(3_600_000);
    expect(EXTERNAL_ISSUE_GH_MAX_PAGES).toBe(3);
  });

  it('keeps the periodic checks of one hour inside the gh budget when every check reads the maximum number of pages', () => {
    // 既定の間隔で 1 時間に確認できる回数 × 1 回の確認の最大のページ数 = 12。定期の確認だけなら、枠に当たらない。
    const checksPerHour = EXTERNAL_ISSUE_GH_CALL_WINDOW_MS / EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS;
    expect(checksPerHour * EXTERNAL_ISSUE_GH_MAX_PAGES).toBeLessThanOrEqual(EXTERNAL_ISSUE_GH_CALLS_PER_HOUR);
  });

  it('keeps the largest interval far below the 2^31-1 ms where setTimeout would fire at once', () => {
    expect(EXTERNAL_ISSUE_POLL_MAX_INTERVAL_MS).toBe(86_400_000);
    expect(EXTERNAL_ISSUE_POLL_MAX_INTERVAL_MS).toBeLessThan(2 ** 31 - 1);
  });
});

describe('resolveExternalIssuePollIntervalMs', () => {
  it.each([
    ['the default itself', 900_000, 900_000],
    ['the floor itself', 300_000, 300_000],
    ['one ms under the floor', 299_999, 300_000],
    ['a one-minute request', 60_000, 300_000],
    ['zero', 0, 300_000],
    ['a negative value', -1, 300_000],
    ['a value over the floor', 600_000, 600_000],
    ['a fraction (cut to a whole number first)', 600_000.9, 600_000],
    ['the ceiling itself', 86_400_000, 86_400_000],
    ['one ms over the ceiling', 86_400_001, 86_400_000],
    ['a value that would overflow setTimeout', 99_999_999_999, 86_400_000],
  ])('%s', (_label, requested, expected) => {
    expect(resolveExternalIssuePollIntervalMs(requested)).toBe(expected);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('falls back to the default for %s', (_label, requested) => {
    expect(resolveExternalIssuePollIntervalMs(requested)).toBe(EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS);
  });
});

describe('nextExternalIssuePollDelayMs', () => {
  const baseMs = 900_000;

  it('keeps the base interval after a success', () => {
    expect(nextExternalIssuePollDelayMs({ baseMs, previousMs: baseMs, errorKind: null })).toBe(baseMs);
  });

  it('doubles on each rate-limited or failed result and stops at one hour', () => {
    for (const kind of ['rate-limited', 'failed']) {
      const delays: number[] = [];
      let previousMs = baseMs;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        previousMs = nextExternalIssuePollDelayMs({ baseMs, previousMs, errorKind: kind });
        delays.push(previousMs);
      }
      expect(delays, kind).toEqual([1_800_000, 3_600_000, 3_600_000, 3_600_000]);
    }
  });

  it('goes back to the base interval after a success that follows a stretched one', () => {
    expect(nextExternalIssuePollDelayMs({ baseMs, previousMs: 3_600_000, errorKind: null })).toBe(baseMs);
  });

  it('starts from the five-minute floor too (5 -> 10 -> 20 -> 40 -> 60 minutes)', () => {
    let previousMs = EXTERNAL_ISSUE_POLL_MIN_INTERVAL_MS;
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      previousMs = nextExternalIssuePollDelayMs({ baseMs: EXTERNAL_ISSUE_POLL_MIN_INTERVAL_MS, previousMs, errorKind: 'failed' });
      delays.push(previousMs);
    }
    expect(delays).toEqual([600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
  });

  it.each(['gh-missing', 'gh-unauthenticated', 'bd-failed', 'storage-failed', 'unexpected', 'something-new'])(
    'does not stretch for %s (waiting does not fix it, and it is not load on GitHub)',
    (kind) => {
      expect(nextExternalIssuePollDelayMs({ baseMs, previousMs: 3_600_000, errorKind: kind })).toBe(baseMs);
    },
  );

  it('never makes a failure shorter than the normal interval when the base is over an hour', () => {
    const twoHours = 7_200_000;
    expect(nextExternalIssuePollDelayMs({ baseMs: twoHours, previousMs: twoHours, errorKind: 'failed' })).toBe(twoHours);
    expect(nextExternalIssuePollDelayMs({ baseMs: twoHours, previousMs: twoHours, errorKind: 'rate-limited' })).toBe(twoHours);
  });
});
