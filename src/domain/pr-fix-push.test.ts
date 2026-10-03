import { describe, expect, it } from 'vitest';
import { countPostCreateCommits } from './pr-fix-push.js';

const CREATED_AT = '2026-10-01T10:00:00Z';

describe('countPostCreateCommits', () => {
  it('counts only commits committed strictly after the PR was created', () => {
    expect(
      countPostCreateCommits(CREATED_AT, [
        { committedDate: '2026-10-01T09:00:00Z' },
        { committedDate: '2026-10-01T10:00:00Z' },
        { committedDate: '2026-10-01T10:00:01Z' },
        { committedDate: '2026-10-02T00:00:00Z' },
      ]),
    ).toBe(2);
  });

  it('returns 0 (a known value) when every commit predates the PR', () => {
    expect(
      countPostCreateCommits(CREATED_AT, [{ committedDate: '2026-10-01T09:59:59Z' }]),
    ).toBe(0);
  });

  it('returns 0 for a PR with an empty commit list', () => {
    expect(countPostCreateCommits(CREATED_AT, [])).toBe(0);
  });

  it('returns undefined (unknown, not 0) when createdAt or commits are missing', () => {
    expect(
      countPostCreateCommits(undefined, [{ committedDate: '2026-10-02T00:00:00Z' }]),
    ).toBeUndefined();
    expect(countPostCreateCommits(null, [])).toBeUndefined();
    expect(countPostCreateCommits(CREATED_AT, undefined)).toBeUndefined();
    expect(countPostCreateCommits(CREATED_AT, null)).toBeUndefined();
  });

  it('returns undefined when createdAt is not a valid timestamp', () => {
    expect(
      countPostCreateCommits('not-a-date', [{ committedDate: '2026-10-02T00:00:00Z' }]),
    ).toBeUndefined();
  });

  it('skips commits whose committedDate is missing or unreadable', () => {
    expect(
      countPostCreateCommits(CREATED_AT, [
        {},
        { committedDate: null },
        { committedDate: 'garbage' },
        { committedDate: '2026-10-02T00:00:00Z' },
      ]),
    ).toBe(1);
  });

  it('compares instants, not strings, across UTC offsets', () => {
    // 2026-10-01T19:30:00+09:00 == 2026-10-01T10:30:00Z (after createdAt)
    expect(
      countPostCreateCommits(CREATED_AT, [{ committedDate: '2026-10-01T19:30:00+09:00' }]),
    ).toBe(1);
    // 2026-10-01T18:30:00+09:00 == 2026-10-01T09:30:00Z (before createdAt)
    expect(
      countPostCreateCommits(CREATED_AT, [{ committedDate: '2026-10-01T18:30:00+09:00' }]),
    ).toBe(0);
  });
});
