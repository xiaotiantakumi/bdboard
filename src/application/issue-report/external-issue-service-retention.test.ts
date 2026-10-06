import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT,
  createSnapshotRecord,
  prepareExternalIssue,
  type StoredExternalIssueSnapshot,
} from '../../domain/external-issue-snapshot-record.js';
import { DAY_MS, createHarness, makeIssue, withBody } from './external-issue-test-support.js';

describe('retention: a snapshot of an issue that left the list', () => {
  it('marks it at the first poll that does not list it (one write), keeps it for 30 days, then removes it', async () => {
    const h = createHarness([makeIssue(5), makeIssue(6)]);
    await h.service.poll();
    expect(h.storage.saves).toEqual([5, 6]);

    h.advance(DAY_MS);
    h.setIssues([makeIssue(6)]);
    const markedAt = h.nowIso();
    const list = await h.service.poll();
    expect(list.issues.map((entry) => entry.number)).toEqual([6]);
    expect(h.storage.files.get(5)?.missingSince).toBe(markedAt);
    expect(h.storage.saves).toEqual([5, 6, 5]);

    // 外れたままの poll で、もう書かない (印は最初の 1 回だけ)。
    h.advance(DAY_MS);
    await h.service.poll();
    expect(h.storage.saves).toEqual([5, 6, 5]);

    // 外れてから 30 日の 1 ミリ秒前までは残り、ちょうど 30 日で消える。
    h.advance(30 * DAY_MS - DAY_MS - 1);
    await h.service.poll();
    expect(h.storage.files.has(5)).toBe(true);
    h.advance(1);
    await h.service.poll();
    expect(h.storage.files.has(5)).toBe(false);
    expect(h.storage.removes).toEqual([5]);
    expect(h.storage.files.has(6)).toBe(true);
  });

  it('counts the 30 days from when the issue left the list, not from when its snapshot was taken', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.advance(100 * DAY_MS);
    h.setIssues([]);
    await h.service.poll();
    expect(h.storage.files.has(5)).toBe(true);
    expect(h.storage.removes).toEqual([]);
  });

  it('clears the mark when the issue comes back, and an edit made while it was away shows up against the old snapshot', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.advance(DAY_MS);
    h.setIssues([]);
    await h.service.poll();
    expect(h.storage.files.get(5)?.missingSince).not.toBeNull();

    h.advance(10 * DAY_MS);
    h.setIssues([withBody(5, 'edited while it was away')]);
    const list = await h.service.poll();
    expect(list.issues[0]?.snapshot.needsRejudge).toBe(true);
    expect(h.storage.files.get(5)).toMatchObject({ missingSince: null, needsRejudge: true, body: 'body text' });
  });

  it('clears the mark of an unedited issue that comes back, without marking it for rejudging', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([]);
    await h.service.poll();
    h.setIssues([makeIssue(5)]);
    const list = await h.service.poll();
    expect(list.issues[0]?.snapshot.needsRejudge).toBe(false);
    expect(h.storage.files.get(5)?.missingSince).toBeNull();
  });

  it('treats an issue that a bd ticket was linked to later like one that left the list', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setRefs(['gh-5']);
    await h.service.poll();
    expect(h.service.getList().issues).toEqual([]);
    expect(h.storage.files.get(5)?.missingSince).toBe(h.nowIso());
    h.advance(30 * DAY_MS);
    await h.service.poll();
    expect(h.storage.files.has(5)).toBe(false);
  });

  it('does not mark or remove by age when the listing was cut short by the page limit (the issue may still be open)', async () => {
    const h = createHarness([makeIssue(5), makeIssue(7)]);
    await h.service.poll();
    h.setIssues([makeIssue(7)]);
    await h.service.poll();
    expect(h.storage.files.get(5)?.missingSince).not.toBeNull();
    h.advance(40 * DAY_MS);
    h.setIssues([makeIssue(9)], { truncatedByPageLimit: true });
    h.storage.saves.length = 0;

    const list = await h.service.poll();

    expect(list.truncated).toBe(true);
    // 7 は一覧に無いが、続きがありうるので外れた印は付けない。5 は 30 日を過ぎているが、消さない。
    expect(h.storage.files.get(7)?.missingSince).toBeNull();
    expect(h.storage.files.has(5)).toBe(true);
    expect(h.storage.removes).toEqual([]);
    expect(h.storage.saves).toEqual([9]);

    h.setIssues([makeIssue(9)]);
    await h.service.poll();
    expect(h.storage.files.has(5)).toBe(false);
    expect(h.storage.files.get(7)?.missingSince).toBe(h.nowIso());
  });

  it('removes nothing when gh fails, however old the snapshots are', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([]);
    await h.service.poll();
    h.advance(90 * DAY_MS);
    h.setListing({ ok: false, kind: 'rate-limited', detail: 'limit' });
    await h.service.poll();
    expect(h.storage.files.has(5)).toBe(true);
    expect(h.storage.removes).toEqual([]);
  });

  it('keeps at most 500 snapshots: the ones that left the list earliest go first, the ones on the list are never removed', async () => {
    const h = createHarness();
    const listed = Array.from({ length: EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT - 2 }, (_, index) => makeIssue(index + 1));
    // 外れた写しを 5 件、外れた時刻を変えて仕込む (古い順に 9001..9005)。
    for (let index = 0; index < 5; index += 1) {
      const record: StoredExternalIssueSnapshot = {
        ...createSnapshotRecord(prepareExternalIssue(makeIssue(9001 + index)), new Date(Date.UTC(2026, 8, 1)).toISOString()),
        missingSince: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
      };
      h.storage.files.set(record.number, record);
    }
    h.setIssues(listed);

    await h.service.poll();

    expect(h.storage.files.size).toBe(EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT);
    expect([...h.storage.removes].sort((a, b) => a - b)).toEqual([9001, 9002, 9003]);
    expect(h.storage.files.has(9004)).toBe(true);
    expect(h.storage.files.has(9005)).toBe(true);
    for (const issue of listed) expect(h.storage.files.has(issue.number)).toBe(true);
  });

  it('still reports ok when an old snapshot cannot be removed (it warns with the number and the code, and tries again next time)', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([]);
    await h.service.poll();
    h.advance(31 * DAY_MS);
    h.storage.failRemove = Object.assign(new Error('permission denied for /example/path'), { code: 'EPERM' });

    const list = await h.service.poll();

    expect(list.state).toBe('ok');
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]?.[0]).toBe('external issue snapshot 5 could not be removed: remove failed (EPERM)');
    h.storage.failRemove = undefined;
    await h.service.poll();
    expect(h.storage.files.has(5)).toBe(false);
  });
});

describe('poll runs one at a time', () => {
  it('a poll started while another is running joins it: one read of gh, the same result for both', async () => {
    const h = createHarness([makeIssue(5)]);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.source.listOpenIssues.mockImplementationOnce(async () => {
      await held;
      return { ok: true, issues: [makeIssue(5)], pagesFetched: 1, truncatedByPageLimit: false, skippedLines: 0 };
    });

    const first = h.service.poll();
    const second = h.service.poll();
    const third = h.service.poll();
    expect(h.source.listOpenIssues).toHaveBeenCalledTimes(1);
    release();
    const results = await Promise.all([first, second, third]);

    expect(h.source.listOpenIssues).toHaveBeenCalledTimes(1);
    expect(h.refReader.listExternalRefs).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    expect(h.storage.saves).toEqual([5]);
  });

  it('starts a new one once the earlier one is done (also after it failed)', async () => {
    const h = createHarness([makeIssue(5)]);
    h.source.listOpenIssues.mockRejectedValueOnce(new Error('boom'));
    expect((await h.service.poll()).state).toBe('error');
    expect((await h.service.poll()).state).toBe('ok');
    await h.service.poll();
    expect(h.source.listOpenIssues).toHaveBeenCalledTimes(3);
  });

  it('resnapshot keeps an error that a poll reported while the snapshot was being saved (it does not put back the earlier state)', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([withBody(5, 'edited')]);
    await h.service.poll();
    let releaseSave: () => void = () => undefined;
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = h.storage.save.bind(h.storage);
    h.storage.save = async (snapshot) => {
      await saveHeld;
      return save(snapshot);
    };

    const resnapshotting = h.service.resnapshot(5);
    // 保存を待つあいだに、gh の失敗で poll が error を付ける (排他の外で一覧を差し替える)。
    h.setListing({ ok: false, kind: 'rate-limited', detail: 'limit' });
    await h.service.poll();
    releaseSave();

    expect(await resnapshotting).toMatchObject({ ok: true });
    expect(h.service.getList()).toMatchObject({ state: 'error', error: { kind: 'rate-limited' } });
    expect(h.service.getList().issues[0]?.snapshot.needsRejudge).toBe(false);
  });

  it('resnapshot waits for the poll that is saving, so the two do not overwrite each other with a stale read', async () => {
    const h = createHarness([makeIssue(5)]);
    await h.service.poll();
    h.setIssues([withBody(5, 'edited')]);
    const gate = h.storage.gateScan();

    const polling = h.service.poll();
    // poll が写しを読む (書く前) ところで止まっているあいだに、取り直しを頼む。
    await gate.entered;
    const resnapshotting = h.service.resnapshot(5);
    gate.release();
    const [list, result] = await Promise.all([polling, resnapshotting]);

    // 取り直しは poll が一覧を差し替えた後に走るので、編集後の本文を写しにし、印を下ろす (古い一覧の本文で写して、
    // その後に poll の印の書き込みが勝つ、にはならない)。
    expect(result).toMatchObject({ ok: true, snapshot: { body: 'edited', needsRejudge: false } });
    expect(h.storage.files.get(5)).toMatchObject({ body: 'edited', needsRejudge: false });
    expect(list.issues[0]?.body).toBe('edited');
    expect(h.service.getList().issues[0]?.snapshot.needsRejudge).toBe(false);
    expect(h.storage.saves).toEqual([5, 5, 5]);
  });
});
