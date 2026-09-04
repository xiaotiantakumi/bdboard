import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import {
  formatDurationMs,
  formatKpiTimestamp,
  formatRatePercent,
  formatShare,
  NO_VALUE_LABEL,
} from './throughputStatsFormatting';

describe('formatDurationMs', () => {
  it('returns the no-value label for null', () => {
    expect(formatDurationMs(null)).toBe(NO_VALUE_LABEL);
  });

  it('switches unit at each order of magnitude', () => {
    expect(formatDurationMs(0)).toBe('0秒');
    expect(formatDurationMs(45_000)).toBe('45秒');
    expect(formatDurationMs(60_000)).toBe('1分');
    expect(formatDurationMs(90 * 60_000)).toBe('1.5時間');
    expect(formatDurationMs(36 * 60 * 60_000)).toBe('1.5日');
  });

  it('uses the larger unit exactly on the boundary', () => {
    expect(formatDurationMs(60 * 60_000)).toBe('1.0時間');
    expect(formatDurationMs(24 * 60 * 60_000)).toBe('1.0日');
  });
});

describe('formatRatePercent', () => {
  it('renders one decimal place', () => {
    expect(formatRatePercent(0)).toBe('0.0%');
    expect(formatRatePercent(0.375)).toBe('37.5%');
    expect(formatRatePercent(1)).toBe('100.0%');
  });

  it('returns the no-value label for null', () => {
    expect(formatRatePercent(null)).toBe(NO_VALUE_LABEL);
  });
});

describe('formatShare', () => {
  it('renders matched, total and the rate', () => {
    expect(formatShare(3, 8, 0.375)).toBe('3件 / 8件 (37.5%)');
  });

  it('does not claim a rate when the denominator is zero', () => {
    expect(formatShare(0, 0, null)).toBe(`0件 / 0件 (${NO_VALUE_LABEL})`);
  });
});

describe('formatKpiTimestamp', () => {
  beforeEach(() => {
    setBoardTimeZoneOverride('Asia/Tokyo');
  });

  afterEach(() => {
    resetBoardTimeZoneForTests();
  });

  it('formats an ISO instant in the board time zone', () => {
    expect(formatKpiTimestamp('2026-08-18T00:00:00.000Z')).toBe('2026-08-18 09:00');
  });

  it('returns the no-value label for null or an unparseable value', () => {
    expect(formatKpiTimestamp(null)).toBe(NO_VALUE_LABEL);
    expect(formatKpiTimestamp('not-a-date')).toBe(NO_VALUE_LABEL);
  });
});
