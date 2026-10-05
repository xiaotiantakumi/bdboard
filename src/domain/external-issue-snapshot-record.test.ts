import { describe, expect, it } from 'vitest';
import { EXTERNAL_ISSUE_BODY_MAX, EXTERNAL_ISSUE_BODY_TRUNCATION_MARK, EXTERNAL_ISSUE_TITLE_MAX } from './external-issue-checks.js';
import {
  EXTERNAL_ISSUE_NUMBER_PATTERN,
  EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT,
  EXTERNAL_ISSUE_SNAPSHOT_RETENTION_DAYS,
  EXTERNAL_ISSUE_SNAPSHOT_RETENTION_MS,
  createSnapshotRecord,
  isExternalIssueNumber,
  prepareExternalIssue,
  selectSnapshotsToRemove,
} from './external-issue-snapshot-record.js';

// 見えない文字はソースに直接書かず、実行時に組む (Trojan Source の検査に当たる)。
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);

const NOW = Date.parse('2026-10-06T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const isoAgo = (ms: number): string => new Date(NOW - ms).toISOString();

describe('the number rule', () => {
  it('pins the pattern from the ticket', () => {
    expect(EXTERNAL_ISSUE_NUMBER_PATTERN.source).toBe('^[1-9][0-9]{0,9}$');
  });

  it.each([1, 9, 10, 42, 123456789, 9_999_999_999])('accepts %d', (value) => {
    expect(isExternalIssueNumber(value)).toBe(true);
  });

  it.each([0, -1, 1.5, 10_000_000_000, Number.NaN, Number.POSITIVE_INFINITY, 1e21, Number.MAX_SAFE_INTEGER])(
    'rejects %s',
    (value) => {
      expect(isExternalIssueNumber(value)).toBe(false);
    },
  );

  it.each(['12', '', null, undefined, {}, [1]])('rejects the non-number %j', (value) => {
    expect(isExternalIssueNumber(value)).toBe(false);
  });

  it.each(['01', '', '0', '12345678901', '1a', '-1', '1.0', '1\n', ' 1'])('the pattern rejects the text %j', (text) => {
    expect(EXTERNAL_ISSUE_NUMBER_PATTERN.test(text)).toBe(false);
  });
});

describe('prepareExternalIssue: truncate first, then check', () => {
  const base = { number: 7, updatedAt: '2026-10-05T00:00:00Z' };

  it('passes the number and the current updatedAt through and runs the checks on the text', () => {
    const prepared = prepareExternalIssue({ ...base, title: `fix${ZWSP}it`, body: 'see <!-- hidden --> https://example.com/x' });
    expect(prepared).toMatchObject({
      number: 7,
      updatedAt: '2026-10-05T00:00:00Z',
      title: `fix${ZWSP}it`,
      titleTruncated: false,
      bodyTruncated: false,
    });
    expect(prepared.checks.title.invisibleChars.total).toBe(1);
    expect(prepared.checks.body.htmlComments.count).toBe(1);
    expect(prepared.checks.body.links.total).toBe(1);
  });

  it('cuts the body at the limit before the checks: what lies past the cut is neither checked nor kept', () => {
    // 先頭の見えない文字は検査に入り、切った先 (20,000 文字より後ろ) の見えない文字・コメントは検査にも写しにも入らない。
    const body = `a${ZWSP}${'b'.repeat(EXTERNAL_ISSUE_BODY_MAX)}${ZWSP}${RLO}<!-- past the cut -->`;
    const prepared = prepareExternalIssue({ ...base, title: 't', body });
    expect(prepared.bodyTruncated).toBe(true);
    expect(prepared.body.endsWith(`\n${EXTERNAL_ISSUE_BODY_TRUNCATION_MARK}`)).toBe(true);
    expect(prepared.body.includes(RLO)).toBe(false);
    expect(prepared.body.includes('past the cut')).toBe(false);
    expect(prepared.checks.body.invisibleChars.total).toBe(1);
    expect(prepared.checks.body.htmlComments.count).toBe(0);
  });

  it('cuts the title at 300 before the checks', () => {
    const title = `${'t'.repeat(EXTERNAL_ISSUE_TITLE_MAX)}${ZWSP}`;
    const prepared = prepareExternalIssue({ ...base, title, body: '' });
    expect(prepared.titleTruncated).toBe(true);
    expect(prepared.title).toBe('t'.repeat(EXTERNAL_ISSUE_TITLE_MAX));
    expect(prepared.titleLength).toBe(EXTERNAL_ISSUE_TITLE_MAX + 1);
    expect(prepared.checks.title.invisibleChars.total).toBe(0);
  });

  it('keeps the upstream length: jq cut the body at 20,001 code points, bodyLength says how long it was', () => {
    const prepared = prepareExternalIssue({ ...base, title: 't', body: 'x'.repeat(EXTERNAL_ISSUE_BODY_MAX + 1), bodyLength: 90_000 });
    expect(prepared.bodyTruncated).toBe(true);
    expect(prepared.bodyLength).toBe(90_000);
  });
});

describe('createSnapshotRecord', () => {
  const prepared = prepareExternalIssue({
    number: 12,
    title: 'crash on start',
    body: 'steps\n1. run it',
    updatedAt: '2026-10-05T00:00:00Z',
  });

  it('keeps title, truncated body, lengths, updatedAt, snapshot time, checks and the flags - and nothing else', () => {
    const record = createSnapshotRecord(prepared, '2026-10-06T00:00:00.000Z');
    expect(record).toEqual({
      number: 12,
      title: 'crash on start',
      body: 'steps\n1. run it',
      titleLength: 14,
      bodyLength: 15,
      titleTruncated: false,
      bodyTruncated: false,
      updatedAt: '2026-10-05T00:00:00Z',
      snapshotAt: '2026-10-06T00:00:00.000Z',
      checks: prepared.checks,
      needsRejudge: false,
      missingSince: null,
    });
  });

  it('does not carry over fields of a bigger object (url, author) when given one', () => {
    const bigger = { ...prepared, url: 'https://github.com/o/r/issues/12', author: 'someone', authorAssociation: 'NONE' };
    expect(Object.keys(createSnapshotRecord(bigger, '2026-10-06T00:00:00.000Z')).sort()).toEqual(
      [
        'body',
        'bodyLength',
        'bodyTruncated',
        'checks',
        'missingSince',
        'needsRejudge',
        'number',
        'snapshotAt',
        'title',
        'titleLength',
        'titleTruncated',
        'updatedAt',
      ].sort(),
    );
  });
});

describe('selectSnapshotsToRemove', () => {
  const listed = (number: number) => ({ number, missingSince: null });
  const missing = (number: number, ageMs: number) => ({ number, missingSince: isoAgo(ageMs) });

  it('pins 30 days and 500 from the ticket', () => {
    expect(EXTERNAL_ISSUE_SNAPSHOT_RETENTION_DAYS).toBe(30);
    expect(EXTERNAL_ISSUE_SNAPSHOT_RETENTION_MS).toBe(30 * DAY);
    expect(EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT).toBe(500);
  });

  it('removes a snapshot that has been out of the list for 30 days (exactly 30 days included), not before', () => {
    const records = [missing(1, 30 * DAY), missing(2, 30 * DAY - 1), missing(3, 29 * DAY), missing(4, 400 * DAY)];
    expect(selectSnapshotsToRemove(records, { nowMs: NOW, listingComplete: true }).sort()).toEqual([1, 4]);
  });

  it('never removes a snapshot that is on the list', () => {
    expect(selectSnapshotsToRemove([listed(1), listed(2)], { nowMs: NOW, listingComplete: true })).toEqual([]);
  });

  it('does not remove by age when the listing was cut short (the issue may still be open past the page limit)', () => {
    expect(selectSnapshotsToRemove([missing(1, 400 * DAY)], { nowMs: NOW, listingComplete: false })).toEqual([]);
  });

  it('keeps at most 500: the oldest to leave the list go first, and the ones on the list stay', () => {
    const current = Array.from({ length: 497 }, (_, index) => listed(index + 1));
    // 497 + 5 = 502 件。2 件を消して 500 にする。外れた時刻が古い 2 件 (番号 1000 と 1001) から。
    const records = [
      ...current,
      missing(1002, 3 * DAY),
      missing(1000, 10 * DAY),
      missing(1003, 2 * DAY),
      missing(1001, 5 * DAY),
      missing(1004, 1 * DAY),
    ];
    expect(selectSnapshotsToRemove(records, { nowMs: NOW, listingComplete: true }).sort((a, b) => a - b)).toEqual([1000, 1001]);
  });

  it('applies the cap even when the listing was cut short', () => {
    const current = Array.from({ length: 500 }, (_, index) => listed(index + 1));
    expect(selectSnapshotsToRemove([...current, missing(1000, DAY)], { nowMs: NOW, listingComplete: false })).toEqual([1000]);
  });

  it('counts what age already removes before applying the cap', () => {
    const current = Array.from({ length: 499 }, (_, index) => listed(index + 1));
    // 499 + 2 = 501 件。1 件は 30 日過ぎで消えるので、上限のための削除は要らない。
    const records = [...current, missing(1000, 31 * DAY), missing(1001, DAY)];
    expect(selectSnapshotsToRemove(records, { nowMs: NOW, listingComplete: true })).toEqual([1000]);
  });

  it('cannot go under the cap when everything is on the list (the service cuts the list at 500 first)', () => {
    const current = Array.from({ length: 502 }, (_, index) => listed(index + 1));
    expect(selectSnapshotsToRemove(current, { nowMs: NOW, listingComplete: true })).toEqual([]);
  });

  it('breaks a tie of the same leaving time by the lower number first, so the choice is stable', () => {
    const current = Array.from({ length: 499 }, (_, index) => listed(index + 1));
    const same = isoAgo(DAY);
    const records = [...current, { number: 2000, missingSince: same }, { number: 1999, missingSince: same }];
    expect(selectSnapshotsToRemove(records, { nowMs: NOW, listingComplete: true })).toEqual([1999]);
  });
});
