import { afterEach, describe, expect, it } from 'vitest';
import { getBoardTimeZone, resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from './boardTimeZone';
import { formatAbsoluteTime } from './formatAbsoluteTime';

describe('formatAbsoluteTime (bdboard-os16)', () => {
  afterEach(() => {
    resetBoardTimeZoneForTests();
  });

  it('formats a valid ISO string like toLocaleString() in board timezone', () => {
    const iso = '2026-01-01T12:00:00.000Z';
    expect(formatAbsoluteTime(iso)).toBe(
      new Date(iso).toLocaleString(undefined, { timeZone: getBoardTimeZone() }),
    );
  });

  it('formats a valid epoch ms like toLocaleString() in board timezone', () => {
    const epochMs = new Date('2026-01-01T12:00:00.000Z').getTime();
    expect(formatAbsoluteTime(epochMs)).toBe(
      new Date(epochMs).toLocaleString(undefined, { timeZone: getBoardTimeZone() }),
    );
  });

  it('uses board timezone override rather than host timezone at day boundaries', () => {
    const iso = '2026-08-09T23:00:00.000Z';

    setBoardTimeZoneOverride('UTC');
    const utcLabel = formatAbsoluteTime(iso);

    setBoardTimeZoneOverride('Asia/Tokyo');
    const tokyoLabel = formatAbsoluteTime(iso);

    expect(utcLabel).not.toBe(tokyoLabel);
    expect(utcLabel).toBe(
      new Date(iso).toLocaleString(undefined, { timeZone: 'UTC' }),
    );
    expect(tokyoLabel).toBe(
      new Date(iso).toLocaleString(undefined, { timeZone: 'Asia/Tokyo' }),
    );
  });

  it('returns the original string for an invalid date without throwing', () => {
    expect(formatAbsoluteTime('not-a-date')).toBe('not-a-date');
  });
});
