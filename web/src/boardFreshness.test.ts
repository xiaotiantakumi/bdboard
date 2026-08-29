import { describe, expect, it } from 'vitest';
import {
  computeStatusLevel,
  contactAgeMinutes,
  formatIsoAge,
  formatRelativeAge,
  mergeLastServerContact,
  shouldShowAlertBar,
  STATUS_LABELS,
} from './boardFreshness';

describe('formatIsoAge (bdboard-3tw.125, renamed in bdboard-bn6)', () => {
  const nowMs = new Date('2026-01-01T12:00:00.000Z').getTime();

  it('returns たった今 for less than 1 minute', () => {
    expect(formatIsoAge('2026-01-01T11:59:30.000Z', nowMs)).toBe('たった今');
  });

  it('returns N分前 for 1–59 minutes', () => {
    expect(formatIsoAge('2026-01-01T11:55:00.000Z', nowMs)).toBe('5分前');
  });

  it('returns N時間前 for 60+ minutes', () => {
    expect(formatIsoAge('2026-01-01T10:00:00.000Z', nowMs)).toBe('2時間前');
  });
});

describe('formatRelativeAge (bdboard-d55)', () => {
  // 最終通信は number (lastContactAtMs) で持っているので、文字列を経由せずに
  // 同じ表記へ落とせる入口が要る。
  const nowMs = new Date('2026-01-01T12:00:00.000Z').getTime();

  it.each([
    ['たった今', 30_000],
    ['5分前', 5 * 60_000],
    ['2時間前', 2 * 60 * 60_000],
    // 境界。ここを外すと `< 1` / `< 60` を `<=` に緩めても誰も気付かない
    // (PR#116 fable レビュー minor)。
    ['たった今', 59_000],
    ['1分前', 60_000],
    ['59分前', 59 * 60_000],
    ['1時間前', 60 * 60_000],
  ])('formats %s', (expected, ageMs) => {
    expect(formatRelativeAge(nowMs - ageMs, nowMs)).toBe(expected);
  });

  it('agrees with formatIsoAge for the same instant', () => {
    const generatedAt = '2026-01-01T11:35:00.000Z';
    expect(formatRelativeAge(new Date(generatedAt).getTime(), nowMs)).toBe(
      formatIsoAge(generatedAt, nowMs),
    );
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

  it('returns reconnecting when stream is reconnecting', () => {
    expect(computeStatusLevel('reconnecting', recentContactAtMs, nowMs)).toBe('reconnecting');
  });

  it('prefers reconnecting over delayed when contact is stale', () => {
    const tenMinutesAgoMs = new Date('2026-01-01T11:50:00.000Z').getTime();
    expect(computeStatusLevel('reconnecting', tenMinutesAgoMs, nowMs)).toBe('reconnecting');
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
  it('shows for delayed, disconnected, and reconnecting states', () => {
    expect(shouldShowAlertBar('delayed')).toBe(true);
    expect(shouldShowAlertBar('disconnected')).toBe(true);
    expect(shouldShowAlertBar('reconnecting')).toBe(true);
    expect(shouldShowAlertBar('ok')).toBe(false);
  });
});

describe('STATUS_LABELS', () => {
  it('includes reconnecting label', () => {
    expect(STATUS_LABELS.reconnecting).toBe('再接続中');
  });
});

describe('contactAgeMinutes', () => {
  const nowMs = new Date('2026-01-01T12:00:00.000Z').getTime();

  it('returns floor minutes since lastContactAtMs', () => {
    expect(contactAgeMinutes(new Date('2026-01-01T11:55:00.000Z').getTime(), nowMs)).toBe(5);
  });
});
