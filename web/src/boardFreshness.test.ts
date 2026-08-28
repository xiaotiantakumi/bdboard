import { describe, expect, it } from 'vitest';
import {
  computeStatusLevel,
  contactAgeMinutes,
  formatGeneratedAtAge,
  mergeLastServerContact,
  shouldShowAlertBar,
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

describe('computeStatusLevel (last server contact, bdboard-9qa)', () => {
  const nowMs = new Date('2026-01-01T12:00:00.000Z').getTime();
  const recentContactAtMs = new Date('2026-01-01T11:59:30.000Z').getTime();
  const staleContactAtMs = new Date('2026-01-01T11:55:00.000Z').getTime();

  it('returns disconnected when stream is in error regardless of contact age', () => {
    expect(computeStatusLevel('error', recentContactAtMs, nowMs)).toBe('disconnected');
  });

  it('stays ok when last contact is recent even if board generatedAt would be stale (304 freeze)', () => {
    // Simulates ETag 304: generatedAt frozen 10 minutes ago, but SSE ping just arrived.
    expect(computeStatusLevel('open', recentContactAtMs, nowMs)).toBe('ok');
  });

  it('returns delayed when last server contact is 2+ minutes ago', () => {
    expect(computeStatusLevel('open', staleContactAtMs, nowMs)).toBe('delayed');
  });

  it('returns ok when last contact is unknown (avoids false positives before first contact)', () => {
    expect(computeStatusLevel('open', null, nowMs)).toBe('ok');
    expect(computeStatusLevel('open', undefined, nowMs)).toBe('ok');
  });

  it('returns ok on cold load when react-query dataUpdatedAt is 0 and SSE has not contacted yet', () => {
    expect(computeStatusLevel('connecting', mergeLastServerContact(null, 0), nowMs)).toBe('ok');
  });
});

describe('mergeLastServerContact', () => {
  it('returns the latest timestamp across SSE contact and board fetch success', () => {
    const streamAt = 1000;
    const fetchAt = 2000;
    expect(mergeLastServerContact(streamAt, fetchAt)).toBe(fetchAt);
    expect(mergeLastServerContact(fetchAt, streamAt)).toBe(fetchAt);
  });

  it('ignores null and undefined sources', () => {
    expect(mergeLastServerContact(null, undefined, 1500)).toBe(1500);
    expect(mergeLastServerContact(null, undefined)).toBeUndefined();
  });

  it('react-query の未取得状態 0 を接触時刻として採用しない', () => {
    expect(mergeLastServerContact(null, 0)).toBeUndefined();
  });

  it('ignores non-positive values but keeps positive sources', () => {
    expect(mergeLastServerContact(0, 1500)).toBe(1500);
  });
});

describe('shouldShowAlertBar', () => {
  it('shows for delayed and disconnected states', () => {
    expect(shouldShowAlertBar('delayed')).toBe(true);
    expect(shouldShowAlertBar('disconnected')).toBe(true);
    expect(shouldShowAlertBar('ok')).toBe(false);
  });
});

describe('contactAgeMinutes', () => {
  const nowMs = new Date('2026-01-01T12:00:00.000Z').getTime();

  it('returns floor minutes since lastContactAtMs', () => {
    expect(contactAgeMinutes(new Date('2026-01-01T11:55:00.000Z').getTime(), nowMs)).toBe(5);
  });
});
