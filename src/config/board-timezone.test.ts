import { afterEach, describe, expect, it } from 'vitest';
import { getBoardTimeZone, getBoardTimeZoneOverride } from './board-timezone.js';

describe('board-timezone', () => {
  const originalTimezone = process.env.BDBOARD_TIMEZONE;

  afterEach(() => {
    if (originalTimezone === undefined) {
      delete process.env.BDBOARD_TIMEZONE;
    } else {
      process.env.BDBOARD_TIMEZONE = originalTimezone;
    }
  });

  it('returns override from BDBOARD_TIMEZONE when set', () => {
    process.env.BDBOARD_TIMEZONE = 'America/New_York';
    expect(getBoardTimeZoneOverride()).toBe('America/New_York');
    expect(getBoardTimeZone()).toBe('America/New_York');
  });

  it('falls back to host timezone when override is unset', () => {
    delete process.env.BDBOARD_TIMEZONE;
    expect(getBoardTimeZoneOverride()).toBeUndefined();
    expect(getBoardTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('treats empty override as unset', () => {
    process.env.BDBOARD_TIMEZONE = '   ';
    expect(getBoardTimeZoneOverride()).toBeUndefined();
  });
});
