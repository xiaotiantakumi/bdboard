import { describe, expect, it } from 'vitest';
import { formatAbsoluteTime } from './formatAbsoluteTime';

describe('formatAbsoluteTime (bdboard-os16)', () => {
  it('formats a valid ISO string like toLocaleString()', () => {
    const iso = '2026-01-01T12:00:00.000Z';
    expect(formatAbsoluteTime(iso)).toBe(new Date(iso).toLocaleString());
  });

  it('formats a valid epoch ms like toLocaleString()', () => {
    const epochMs = new Date('2026-01-01T12:00:00.000Z').getTime();
    expect(formatAbsoluteTime(epochMs)).toBe(new Date(epochMs).toLocaleString());
  });

  it('returns the original string for an invalid date without throwing', () => {
    expect(formatAbsoluteTime('not-a-date')).toBe('not-a-date');
  });
});
