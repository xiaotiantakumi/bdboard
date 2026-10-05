import { describe, expect, it } from 'vitest';
import { EXTERNAL_ISSUE_BODY_MAX, EXTERNAL_ISSUE_BODY_TRUNCATION_MARK, EXTERNAL_ISSUE_TITLE_MAX } from '../../domain/external-issue-checks.js';
import { EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT } from '../../domain/external-issue-snapshot-record.js';
import { PROJECT_ROOT, createHarness, makeIssue, withBody } from './external-issue-test-support.js';

// 見えない文字はソースに直接書かず、実行時に組む (Trojan Source の検査に当たる)。
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const SECRET_ERROR_TEXT = 'example-secret-error-text';

describe('poll: the list', () => {
  it('starts idle, and a poll lists the open issues with their current text, checks and snapshot summary', async () => {
    const h = createHarness([makeIssue(5, { title: `fix${ZWSP}it`, body: 'see https://example.com/x', bodyLength: 25 })]);
    expect(h.service.getList()).toEqual({ state: 'idle', fetchedAt: null, issues: [], error: null, truncated: false, skippedLines: 0 });

    const list = await h.service.poll();

    expect(list).toMatchObject({ state: 'ok', fetchedAt: h.nowIso(), error: null, truncated: false, skippedLines: 0 });
    expect(list.issues).toHaveLength(1);
    expect(list.issues[0]).toMatchObject({
      number: 5,
      url: 'https://github.com/xiaotiantakumi/bdboard/issues/5',
      author: 'someone',
      authorAssociation: 'NONE',
      title: `fix${ZWSP}it`,
      body: 'see https://example.com/x',
      titleTruncated: false,
      bodyTruncated: false,
      updatedAt: '2026-10-05T00:00:00Z',
      snapshot: { snapshotAt: h.nowIso(), updatedAt: '2026-10-05T00:00:00Z', needsRejudge: false, updatedAtChanged: false },
    });
    expect(list.issues[0]?.checks.title.invisibleChars.total).toBe(1);
    expect(list.issues[0]?.checks.body.links.total).toBe(1);
    expect(h.service.getList()).toBe(list);
  });

  it('keeps the order gh returned', async () => {
    const h = createHarness([makeIssue(9), makeIssue(3), makeIssue(7)]);
    expect((await h.service.poll()).issues.map((entry) => entry.number)).toEqual([9, 3, 7]);
  });

  it('leaves out the issues that a bd ticket is linked to (gh-N and the issue URL), and reads the refs of the given project', async () => {
    const h = createHarness([makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)]);
    h.setRefs(['gh-2', 'https://github.com/xiaotiantakumi/bdboard/issues/3', 'jira-4', 'https://github.com/someone-else/repo/issues/1']);
    const list = await h.service.poll();
    expect(list.issues.map((entry) => entry.number)).toEqual([1, 4]);
    expect(h.refReader.listExternalRefs).toHaveBeenCalledWith(PROJECT_ROOT);
    // 紐付いたものには写しも作らない。
    expect([...h.storage.files.keys()].sort((a, b) => a - b)).toEqual([1, 4]);
  });

  it('turns an empty answer into an ok list with no issues', async () => {
    const h = createHarness([]);
    expect(await h.service.poll()).toMatchObject({ state: 'ok', issues: [] });
  });

  it('passes on what gh said about the listing: cut short by the page limit, lines it could not read', async () => {
    const h = createHarness([makeIssue(1)]);
    h.setIssues([makeIssue(1)], { truncatedByPageLimit: true, skippedLines: 2 });
    expect(await h.service.poll()).toMatchObject({ state: 'ok', truncated: true, skippedLines: 2 });
  });

  it('takes at most 500 issues (the cap on snapshots), in the order given, and says the list is cut', async () => {
    const issues = Array.from({ length: EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT + 2 }, (_, index) => makeIssue(index + 1));
    const h = createHarness(issues);
    const list = await h.service.poll();
    expect(list.issues).toHaveLength(EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT);
    expect(list.issues.at(-1)?.number).toBe(EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT);
    expect(list.truncated).toBe(true);
    expect(h.storage.files.size).toBe(EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT);
  });
});

describe('poll: the snapshot is taken when the issue is first seen', () => {
  it('saves the title, the truncated body, the lengths, updatedAt, the snapshot time, the checks and needsRejudge=false', async () => {
    const h = createHarness([makeIssue(5, { title: `fix${ZWSP}it`, body: 'a <!-- c --> b', bodyLength: 14 })]);
    await h.service.poll();
    const record = h.storage.files.get(5);
    expect(record).toMatchObject({
      number: 5,
      title: `fix${ZWSP}it`,
      body: 'a <!-- c --> b',
      titleLength: 6,
      bodyLength: 14,
      titleTruncated: false,
      bodyTruncated: false,
      updatedAt: '2026-10-05T00:00:00Z',
      snapshotAt: h.nowIso(),
      needsRejudge: false,
      missingSince: null,
    });
    expect(record?.checks.title.invisibleChars.total).toBe(1);
    expect(record?.checks.body.htmlComments.count).toBe(1);
  });

  it('cuts before it checks and before it saves: nothing past the limit reaches the checks or the file', async () => {
    const body = `a${ZWSP}${'b'.repeat(EXTERNAL_ISSUE_BODY_MAX)}${RLO}<!-- past the cut -->`;
    const title = `${'t'.repeat(EXTERNAL_ISSUE_TITLE_MAX)}${ZWSP}`;
    const h = createHarness([withBody(5, body, { title })]);
    const list = await h.service.poll();

    const record = h.storage.files.get(5);
    expect(record?.titleTruncated).toBe(true);
    expect(record?.title).toBe('t'.repeat(EXTERNAL_ISSUE_TITLE_MAX));
    expect(record?.bodyTruncated).toBe(true);
    expect(record?.body.endsWith(`\n${EXTERNAL_ISSUE_BODY_TRUNCATION_MARK}`)).toBe(true);
    expect(record?.body.includes(RLO)).toBe(false);
    expect(record?.body.includes('past the cut')).toBe(false);
    // 全長は切る前のもの (切った先の編集を、長さで拾うため)。
    expect(record?.bodyLength).toBe(Array.from(body).length);
    expect(record?.titleLength).toBe(EXTERNAL_ISSUE_TITLE_MAX + 1);
    // 検査も切った後の文字列にかかる: 先頭の見えない文字は数え、切った先の RLO・コメントは数えない。
    expect(record?.checks.body.invisibleChars.total).toBe(1);
    expect(record?.checks.body.htmlComments.count).toBe(0);
    expect(record?.checks.title.invisibleChars.total).toBe(0);
    // 一覧の現在の内容も同じ。
    expect(list.issues[0]?.body).toBe(record?.body);
    expect(list.issues[0]?.checks).toEqual(record?.checks);
  });

  it('does not save the comments or anything else about the issue (author and url stay out of the file)', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    expect(Object.keys(h.storage.files.get(5) ?? {}).sort()).toEqual(
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

describe('poll: edits on the GitHub side', () => {
  it('does nothing to the file when nothing changed (no write on a later poll)', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    const before = structuredClone(h.storage.files.get(5));
    h.advance(15 * 60 * 1000);
    const list = await h.service.poll();
    expect(h.storage.saves).toEqual([5]);
    expect(h.storage.files.get(5)).toEqual(before);
    expect(list.issues[0]?.snapshot).toMatchObject({ needsRejudge: false, updatedAtChanged: false });
  });

  it('marks needsRejudge when the body is edited, keeps the judged-time copy in the file, and keeps the mark on the next poll', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    const firstSnapshotAt = h.nowIso();

    h.advance(60_000);
    h.setIssues([withBody(5, 'a different body', { updatedAt: '2026-10-05T01:00:00Z' })]);
    const second = await h.service.poll();

    expect(second.issues[0]).toMatchObject({
      body: 'a different body',
      updatedAt: '2026-10-05T01:00:00Z',
      snapshot: { needsRejudge: true, snapshotAt: firstSnapshotAt, updatedAt: '2026-10-05T00:00:00Z', updatedAtChanged: true },
    });
    // 写しは判定した時点のまま (本文は書き換えない)。印だけが記録に残る。
    expect(h.storage.files.get(5)).toMatchObject({ body: 'body text', needsRejudge: true, snapshotAt: firstSnapshotAt, updatedAt: '2026-10-05T00:00:00Z' });

    // 次の poll (中身は変わらない) でも残る。
    h.advance(15 * 60 * 1000);
    const third = await h.service.poll();
    expect(third.issues[0]?.snapshot.needsRejudge).toBe(true);
    expect(h.storage.files.get(5)?.needsRejudge).toBe(true);
  });

  it('keeps the mark even if the text is edited back to the original (it stays until the snapshot is taken again)', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([withBody(5, 'a different body')]);
    await h.service.poll();
    h.setIssues([makeIssue(5)]);
    const list = await h.service.poll();
    expect(list.issues[0]?.snapshot.needsRejudge).toBe(true);
  });

  it('marks needsRejudge when the title is edited', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([makeIssue(5, { title: 'a new title' })]);
    expect((await h.service.poll()).issues[0]?.snapshot.needsRejudge).toBe(true);
  });

  it('does not mark needsRejudge when only updatedAt moved (a comment, a label), but says updatedAt changed', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([makeIssue(5, { updatedAt: '2026-10-06T03:00:00Z' })]);
    const list = await h.service.poll();
    expect(list.issues[0]?.snapshot).toMatchObject({ needsRejudge: false, updatedAtChanged: true, updatedAt: '2026-10-05T00:00:00Z' });
    expect(h.storage.files.get(5)?.needsRejudge).toBe(false);
    expect(h.storage.saves).toEqual([5]);
  });

  it('catches an edit past the truncation cut by the full length', async () => {
    const original = `${'x'.repeat(EXTERNAL_ISSUE_BODY_MAX)}tail one`;
    const h = createHarness([withBody(5, original)]);
    await h.service.poll();
    // 切り詰めた先の 20,000 文字は同じで、先が長くなった。
    h.setIssues([withBody(5, `${original} and more`)]);
    const list = await h.service.poll();
    expect(list.issues[0]?.body).toBe(h.storage.files.get(5)?.body);
    expect(list.issues[0]?.snapshot.needsRejudge).toBe(true);
  });

  it('keeps the snapshot and the mark across a restart of the service (they live in the storage, not in memory)', async () => {
    const first = createHarness([makeIssue(5)]);
    await first.service.poll();
    first.setIssues([withBody(5, 'edited')]);
    await first.service.poll();

    const restarted = createHarness([withBody(5, 'edited')], first.storage);
    const list = await restarted.service.poll();
    expect(list.issues[0]?.snapshot).toMatchObject({ needsRejudge: true, snapshotAt: '2026-10-06T00:00:00.000Z' });
    expect(restarted.storage.files.get(5)?.body).toBe('body text');
  });
});

describe('resnapshot', () => {
  it('takes the snapshot again from the current text and clears the mark, in the file and in the list', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.advance(60_000);
    h.setIssues([withBody(5, 'edited body', { updatedAt: '2026-10-05T02:00:00Z' })]);
    await h.service.poll();
    h.advance(60_000);

    const result = await h.service.resnapshot(5);

    expect(result).toMatchObject({ ok: true, snapshot: { number: 5, body: 'edited body', updatedAt: '2026-10-05T02:00:00Z', needsRejudge: false, snapshotAt: h.nowIso() } });
    expect(h.storage.files.get(5)).toMatchObject({ body: 'edited body', needsRejudge: false, snapshotAt: h.nowIso(), missingSince: null });
    expect(h.service.getList().issues[0]).toMatchObject({
      body: 'edited body',
      snapshot: { needsRejudge: false, snapshotAt: h.nowIso(), updatedAt: '2026-10-05T02:00:00Z', updatedAtChanged: false },
    });
    // 取り直した後の poll は印を付けない。さらに編集されたら、また付く。
    expect((await h.service.poll()).issues[0]?.snapshot.needsRejudge).toBe(false);
    h.setIssues([withBody(5, 'edited again')]);
    expect((await h.service.poll()).issues[0]?.snapshot.needsRejudge).toBe(true);
  });

  it('does not read GitHub again: it uses the text of the last list', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([withBody(5, 'edited on GitHub after the last poll')]);
    await h.service.resnapshot(5);
    expect(h.source.listOpenIssues).toHaveBeenCalledTimes(1);
    expect(h.storage.files.get(5)?.body).toBe('body text');
  });

  it('says not-listed for a number that is not on the last list, and writes nothing (also before the first poll)', async () => {
    const h = createHarness([makeIssue(5)]);
    expect(await h.service.resnapshot(5)).toEqual({ ok: false, reason: 'not-listed' });
    await h.service.poll();
    h.storage.saves.length = 0;
    expect(await h.service.resnapshot(6)).toEqual({ ok: false, reason: 'not-listed' });
    expect(await h.service.resnapshot(Number.NaN)).toEqual({ ok: false, reason: 'not-listed' });
    expect(h.storage.saves).toEqual([]);
  });

  it('says storage-failed and leaves the list as it was when the save fails (it does not throw)', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([withBody(5, 'edited')]);
    const before = await h.service.poll();
    h.storage.failSave = () => Object.assign(new Error('no space'), { code: 'ENOSPC' });
    expect(await h.service.resnapshot(5)).toEqual({ ok: false, reason: 'storage-failed' });
    expect(h.service.getList()).toBe(before);
    expect(h.storage.files.get(5)?.needsRejudge).toBe(true);
  });
});

describe('poll: failures are a state, not an exception', () => {
  it.each([
    ['gh-missing', 'gh is not installed'],
    ['gh-unauthenticated', 'gh is not logged in'],
    ['rate-limited', 'API rate limit exceeded'],
    ['failed', 'gh timed out'],
  ] as const)('gh %s: state=error with its kind and detail; the earlier list stays; nothing is written; bd is not asked', async (kind, detail) => {
    const h = createHarness([makeIssue(5)]);
    const good = await h.service.poll();
    h.storage.saves.length = 0;
    h.refReader.listExternalRefs.mockClear();
    h.advance(60_000);
    h.setListing({ ok: false, kind, detail });

    const list = await h.service.poll();

    expect(list).toMatchObject({ state: 'error', error: { kind, detail }, fetchedAt: good.fetchedAt });
    expect(list.issues).toBe(good.issues);
    expect(h.storage.saves).toEqual([]);
    expect(h.storage.removes).toEqual([]);
    expect(h.refReader.listExternalRefs).not.toHaveBeenCalled();
  });

  it('goes back to ok (and drops the error) on the next successful poll', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setListing({ ok: false, kind: 'rate-limited', detail: 'limit' });
    await h.service.poll();
    h.advance(60_000);
    h.setIssues([makeIssue(5), makeIssue(6)]);
    const list = await h.service.poll();
    expect(list).toMatchObject({ state: 'ok', error: null, fetchedAt: h.nowIso() });
    expect(list.issues.map((entry) => entry.number)).toEqual([5, 6]);
  });

  it('is error with an empty list when the very first poll fails', async () => {
    const h = createHarness();
    h.setListing({ ok: false, kind: 'gh-missing', detail: 'gh is not installed' });
    expect(await h.service.poll()).toEqual({
      state: 'error',
      fetchedAt: null,
      issues: [],
      error: { kind: 'gh-missing', detail: 'gh is not installed' },
      truncated: false,
      skippedLines: 0,
    });
  });

  it('bd failure: state=error "bd-failed" with a fixed detail, no list is built (linked issues would show), nothing is written', async () => {
    const h = createHarness([makeIssue(5)]);
    h.refReader.listExternalRefs.mockRejectedValueOnce(new Error(`bd said ${SECRET_ERROR_TEXT}`));
    const list = await h.service.poll();
    expect(list).toMatchObject({ state: 'error', issues: [], error: { kind: 'bd-failed' } });
    expect(list.error?.detail).not.toContain(SECRET_ERROR_TEXT);
    expect(h.storage.saves).toEqual([]);
  });

  it('storage failure while saving: state=error "storage-failed" (does not throw), the earlier list stays, the detail has the code only', async () => {
    const h = createHarness([makeIssue(5)]);
    const good = await h.service.poll();
    h.setIssues([makeIssue(5), makeIssue(6)]);
    h.storage.failSave = () => Object.assign(new Error(`no space left on /example/path ${SECRET_ERROR_TEXT}`), { code: 'ENOSPC' });

    const list = await h.service.poll();

    expect(list).toMatchObject({ state: 'error', error: { kind: 'storage-failed' }, fetchedAt: good.fetchedAt });
    expect(list.issues).toBe(good.issues);
    expect(list.error?.detail).toContain('ENOSPC');
    expect(list.error?.detail).not.toContain(SECRET_ERROR_TEXT);
    expect(list.error?.detail).not.toContain('/example/path');
  });

  it('storage failure on the very first poll: error with an empty list, so nothing is shown without a saved snapshot', async () => {
    const h = createHarness([makeIssue(5)]);
    h.storage.failSave = () => new Error('read-only file system');
    const list = await h.service.poll();
    expect(list).toMatchObject({ state: 'error', issues: [], error: { kind: 'storage-failed' } });
  });

  it('storage failure while reading the saved snapshots: state=error, and no snapshot is replaced by a new one (a read error is not "absent")', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.storage.saves.length = 0;
    h.setIssues([withBody(5, 'edited')]);
    h.storage.failList = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const list = await h.service.poll();
    expect(list).toMatchObject({ state: 'error', error: { kind: 'storage-failed' } });
    expect(list.error?.detail).toContain('EACCES');
    expect(h.storage.saves).toEqual([]);
    expect(h.storage.files.get(5)?.body).toBe('body text');
  });

  it('recovers when the storage works again, and the earlier snapshots are still the baseline', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([withBody(5, 'edited')]);
    h.storage.failSave = () => new Error('transient');
    await h.service.poll();
    h.storage.failSave = undefined;
    const list = await h.service.poll();
    expect(list.state).toBe('ok');
    expect(list.issues[0]?.snapshot.needsRejudge).toBe(true);
  });

  it('an unexpected exception from a port is also a state ("unexpected"), never a rejection', async () => {
    const h = createHarness([makeIssue(5)]);
    h.source.listOpenIssues.mockRejectedValueOnce(new Error(SECRET_ERROR_TEXT));
    const list = await h.service.poll();
    expect(list).toMatchObject({ state: 'error', error: { kind: 'unexpected' } });
    expect(list.error?.detail).not.toContain(SECRET_ERROR_TEXT);
  });
});
