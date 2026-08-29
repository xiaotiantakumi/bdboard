import { describe, expect, it } from 'vitest';
import { addCalendarDaysToDateKey } from './board-date-time.js';

describe('addCalendarDaysToDateKey', () => {
  const newYork = 'America/New_York';

  it('advances one calendar day on a normal day', () => {
    expect(addCalendarDaysToDateKey('2026-08-15', 1, newYork)).toBe('2026-08-16');
  });

  it('advances across America/New_York DST fall-back day (25 local hours)', () => {
    expect(addCalendarDaysToDateKey('2026-11-01', 1, newYork)).toBe('2026-11-02');
    expect(addCalendarDaysToDateKey('2026-11-01', 5, newYork)).toBe('2026-11-06');
  });

  it('advances seven calendar days across a fall-back week', () => {
    expect(addCalendarDaysToDateKey('2026-10-26', 7, newYork)).toBe('2026-11-02');
  });

  it('advances across America/New_York DST spring-forward day (23 local hours)', () => {
    expect(addCalendarDaysToDateKey('2026-03-08', 1, newYork)).toBe('2026-03-09');
    expect(addCalendarDaysToDateKey('2026-03-02', 7, newYork)).toBe('2026-03-09');
  });
});
