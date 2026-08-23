import { describe, expect, it } from 'vitest';
import {
  computeStatusLevel,
  formatGeneratedAtAge,
  shouldShowAlertBar,
  staleAgeMinutes,
} from './boardFreshness';

describe('formatGeneratedAtAge (bdboard-3tw.125)', () => {
  const nowMs = new Date('2026-01-01T12:00:00.000Z').getTime();

  it('returns たった今 for less than 1 minute', () => {
    expect(formatGeneratedAtAge('2026-01-01T11:59:30.000Z', nowMs)).toBe('たった今');
  });

  it('returns N分前 for 1–59 minutes', () => {
    expect(formatGeneratedAtAge('2026-01-01T11:55:00.000Z', nowMs)).toBe('5分前');
  });

  it('returns N時間前 for 60+ minutes', () => {
    expect(formatGeneratedAtAge('2026-01-01T10:00:00.000Z', nowMs)).toBe('2時間前');
  });
});

describe('computeStatusLevel', () => {
  const nowMs = new Date('2026-01-01T12:00:00.000Z').getTime();

  it('returns disconnected when stream is in error', () => {
    expect(computeStatusLevel('error', '2026-01-01T11:59:00.000Z', nowMs)).toBe(
      'disconnected',
    );
  });

  it('returns delayed when board is 2+ minutes stale', () => {
    expect(computeStatusLevel('open', '2026-01-01T11:55:00.000Z', nowMs)).toBe('delayed');
  });

  it('returns ok when stream is healthy and board is fresh', () => {
    expect(computeStatusLevel('open', '2026-01-01T11:59:30.000Z', nowMs)).toBe('ok');
  });
});

describe('shouldShowAlertBar', () => {
  it('shows for delayed and disconnected states', () => {
    expect(shouldShowAlertBar('delayed')).toBe(true);
    expect(shouldShowAlertBar('disconnected')).toBe(true);
    expect(shouldShowAlertBar('ok')).toBe(false);
  });
});

describe('staleAgeMinutes', () => {
  const nowMs = new Date('2026-01-01T12:00:00.000Z').getTime();

  it('returns floor minutes since generatedAt', () => {
    expect(staleAgeMinutes('2026-01-01T11:55:00.000Z', nowMs)).toBe(5);
  });
});
