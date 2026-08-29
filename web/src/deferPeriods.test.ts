import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetBoardTimeZoneForTests,
  setBoardTimeZoneOverride,
} from './boardTimeZone';
import {
  computeDeferUntilDate,
  isFutureLocalDate,
  todayLocalDateInputValue,
} from './deferPeriods';

describe('computeDeferUntilDate', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetBoardTimeZoneForTests();
  });

  it('uses local calendar days, not UTC conversion', () => {
    const now = new Date(2026, 7, 16, 1, 0, 0);
    expect(computeDeferUntilDate('tomorrow', now)).toBe('2026-08-17');
    expect(computeDeferUntilDate('1week', now)).toBe('2026-08-23');
  });

  it('adds fixed day offsets from local midnight context', () => {
    const now = new Date(2026, 7, 15, 3, 0, 0);
    expect(computeDeferUntilDate('tomorrow', now)).toBe('2026-08-16');
    expect(computeDeferUntilDate('3days', now)).toBe('2026-08-18');
    expect(computeDeferUntilDate('1week', now)).toBe('2026-08-22');
  });

  it('rolls month and year boundaries for one month', () => {
    expect(computeDeferUntilDate('1month', new Date(2026, 0, 31, 12, 0, 0))).toBe(
      '2026-02-28',
    );
    expect(computeDeferUntilDate('1month', new Date(2026, 11, 15, 12, 0, 0))).toBe(
      '2027-01-15',
    );
  });

  it('uses the board timezone override across UTC day boundaries', () => {
    setBoardTimeZoneOverride('Asia/Tokyo');
    const now = new Date('2026-08-16T01:00:00.000Z');

    expect(computeDeferUntilDate('tomorrow', now)).toBe('2026-08-17');
    expect(computeDeferUntilDate('1week', now)).toBe('2026-08-23');
  });
});

describe('todayLocalDateInputValue', () => {
  afterEach(() => {
    resetBoardTimeZoneForTests();
  });

  it('returns the local calendar date as YYYY-MM-DD', () => {
    expect(todayLocalDateInputValue(new Date(2026, 7, 17, 23, 59, 59))).toBe(
      '2026-08-17',
    );
  });

  it('uses the board timezone override across UTC day boundaries', () => {
    setBoardTimeZoneOverride('Asia/Tokyo');
    expect(todayLocalDateInputValue(new Date('2026-08-16T01:00:00.000Z'))).toBe(
      '2026-08-16',
    );
  });
});

describe('isFutureLocalDate', () => {
  afterEach(() => {
    resetBoardTimeZoneForTests();
  });

  const now = new Date(2026, 7, 17, 15, 0, 0);

  it('returns false for today', () => {
    expect(isFutureLocalDate('2026-08-17', now)).toBe(false);
  });

  it('returns true for tomorrow', () => {
    expect(isFutureLocalDate('2026-08-18', now)).toBe(true);
  });

  it('returns false for invalid or empty values', () => {
    expect(isFutureLocalDate('', now)).toBe(false);
    expect(isFutureLocalDate('2026/08/18', now)).toBe(false);
    expect(isFutureLocalDate('not-a-date', now)).toBe(false);
  });

  it('uses the board timezone override across UTC day boundaries', () => {
    setBoardTimeZoneOverride('Asia/Tokyo');
    const boundaryNow = new Date('2026-08-16T01:00:00.000Z');

    expect(isFutureLocalDate('2026-08-16', boundaryNow)).toBe(false);
    expect(isFutureLocalDate('2026-08-17', boundaryNow)).toBe(true);
  });
});
