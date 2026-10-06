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
  // onList は「今回の一覧に載っている」印 (テスト側の都合の欄。関数が見るのは number / missingSince / snapshotAt と listedNumbers だけ)。
  interface Rec {
    readonly number: number;
    readonly missingSince: string | null;
    readonly snapshotAt: string;
    readonly onList: boolean;
  }
  const listed = (number: number, snapshotAt = isoAgo(0)): Rec => ({ number, missingSince: null, snapshotAt, onList: true });
  /** 一覧から外れたと分かっている (外れた時刻は ageMs 前)。 */
  const missing = (number: number, ageMs: number): Rec => ({
    number,
    missingSince: isoAgo(ageMs),
    snapshotAt: isoAgo(ageMs + 100 * DAY),
    onList: false,
  });
  /** 外れた印は無いが、今回の一覧にも載っていない (打ち切られた poll で見えなかっただけ)。 */
  const unseen = (number: number, snapshotAgeMs: number): Rec => ({ number, missingSince: null, snapshotAt: isoAgo(snapshotAgeMs), onList: false });
  const listedRange = (count: number): Rec[] => Array.from({ length: count }, (_, index) => listed(index + 1));
  const select = (records: readonly Rec[], listingComplete: boolean): number[] =>
    selectSnapshotsToRemove(records, {
      nowMs: NOW,
      listingComplete,
      listedNumbers: new Set(records.filter((record) => record.onList).map((record) => record.number)),
    }).sort((a, b) => a - b);

  it('pins 30 days and 500 from the ticket', () => {
    expect(EXTERNAL_ISSUE_SNAPSHOT_RETENTION_DAYS).toBe(30);
    expect(EXTERNAL_ISSUE_SNAPSHOT_RETENTION_MS).toBe(30 * DAY);
    expect(EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT).toBe(500);
  });

  it('removes a snapshot that has been out of the list for 30 days (exactly 30 days included), not before', () => {
    const records = [missing(1, 30 * DAY), missing(2, 30 * DAY - 1), missing(3, 29 * DAY), missing(4, 400 * DAY)];
    expect(select(records, true)).toEqual([1, 4]);
  });

  it('never removes a snapshot that is on the list', () => {
    expect(select([listed(1), listed(2)], true)).toEqual([]);
    // 印がまだ古いままでも、今回の一覧に載っていれば消さない。
    expect(select([{ ...missing(5, 400 * DAY), onList: true }], true)).toEqual([]);
  });

  it('does not remove by age when the listing was cut short (the issue may still be open past the page limit)', () => {
    expect(select([missing(1, 400 * DAY)], false)).toEqual([]);
  });

  it('keeps at most 500: the oldest to leave the list go first, and the ones on the list stay', () => {
    // 497 + 5 = 502 件。2 件を消して 500 にする。外れた時刻が古い 2 件 (番号 1000 と 1001) から。
    const records = [
      ...listedRange(497),
      missing(1002, 3 * DAY),
      missing(1000, 10 * DAY),
      missing(1003, 2 * DAY),
      missing(1001, 5 * DAY),
      missing(1004, 1 * DAY),
    ];
    expect(select(records, true)).toEqual([1000, 1001]);
  });

  it('applies the cap even when the listing was cut short', () => {
    expect(select([...listedRange(500), missing(1000, DAY)], false)).toEqual([1000]);
  });

  it('counts what age already removes before applying the cap', () => {
    // 499 + 2 = 501 件。1 件は 30 日過ぎで消えるので、上限のための削除は要らない。
    expect(select([...listedRange(499), missing(1000, 31 * DAY), missing(1001, DAY)], true)).toEqual([1000]);
  });

  it('cannot go under the cap when everything is on the list (the service cuts the list at 500 first)', () => {
    expect(select(listedRange(502), true)).toEqual([]);
  });

  it('breaks a tie of the same leaving time by the lower number first, so the choice is stable', () => {
    expect(select([...listedRange(499), missing(2000, DAY), missing(1999, DAY)], true)).toEqual([1999]);
  });

  describe('when the listing was cut short and no record has the left-the-list mark (bdboard-558a)', () => {
    it('removes the ones that are not on the list, oldest snapshot time first, down to 500', () => {
      // 497 + 5 = 502 件。2 件を消す。写しを取った時刻が古い 2000 (9 日前) と 2002 (8 日前) から。
      const records = [...listedRange(497), unseen(2000, 9 * DAY), unseen(2001, 7 * DAY), unseen(2002, 8 * DAY), unseen(2003, DAY), unseen(2004, 2 * DAY)];
      expect(select(records, false)).toEqual([2000, 2002]);
    });

    it('never removes a record on the list, whatever its snapshot time, even when the list alone is over 500', () => {
      const records = [...Array.from({ length: 501 }, (_, index) => listed(index + 1, isoAgo(500 * DAY))), unseen(9000, DAY)];
      expect(select(records, false)).toEqual([9000]);
    });

    it('removes the ones known to have left the list before the unseen ones, even if an unseen snapshot is older', () => {
      expect(select([...listedRange(499), unseen(2000, 500 * DAY), missing(2001, DAY)], false)).toEqual([2001]);
    });

    it('takes the unseen ones once the known-left ones run out', () => {
      // 497 + 1 (外れた印あり) + 4 (見えなかった) = 502 件。2 件を消す: 外れた印のある 3000 と、見えなかったうち一番古い 2000。
      const records = [...listedRange(497), missing(3000, DAY), unseen(2000, 9 * DAY), unseen(2001, 7 * DAY), unseen(2002, 8 * DAY), unseen(2003, DAY)];
      expect(select(records, false)).toEqual([2000, 3000]);
    });

    it('breaks a tie of the same snapshot time by the lower number first', () => {
      expect(select([...listedRange(499), unseen(2000, DAY), unseen(1999, DAY)], false)).toEqual([1999]);
    });

    it('removes nothing while the total is within 500', () => {
      expect(select([...listedRange(498), unseen(2000, 9 * DAY), unseen(2001, DAY)], false)).toEqual([]);
    });
  });
});
