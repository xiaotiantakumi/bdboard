import { describe, expect, it } from 'vitest';
import { createHarness, makeIssue, withBody } from './external-issue-test-support.js';

// bdboard-g2ti: 使えない写し (壊れた JSON・旧形式) を作り直すときは、判定時点の写しを失うので needsRejudge=true にする。
// 初めて見た issue (ファイルが無い) は立てない。保存層が「使えない」と言った番号は fake の `storage.unusable` で表す。
describe('poll: a saved snapshot that cannot be used', () => {
  it('does not mark an issue that is seen for the first time (no file at all)', async () => {
    const h = createHarness([makeIssue(3)]);

    const list = await h.service.poll();

    expect(h.storage.files.get(3)).toMatchObject({ needsRejudge: false, missingSince: null });
    expect(list.issues[0]?.snapshot.needsRejudge).toBe(false);
  });

  it('marks needsRejudge when it makes the snapshot again, and the new snapshot is the current content', async () => {
    const h = createHarness([withBody(5, 'current body', { title: 'current title' })]);
    h.storage.unusable.add(5);

    const list = await h.service.poll();

    expect(h.storage.files.get(5)).toMatchObject({
      number: 5,
      title: 'current title',
      body: 'current body',
      needsRejudge: true,
      missingSince: null,
      snapshotAt: h.nowIso(),
    });
    expect(list.issues[0]?.snapshot).toMatchObject({ needsRejudge: true, snapshotAt: h.nowIso() });
    // 使えない写しは書き直されて、使える写しになる。
    expect(h.storage.unusable.has(5)).toBe(false);
  });

  it('keeps the mark on later polls without writing again (it is not lowered by the next poll)', async () => {
    const h = createHarness([makeIssue(5)]);
    h.storage.unusable.add(5);
    await h.service.poll();
    const savesAfterRebuild = h.storage.saves.length;

    h.advance(60_000);
    const list = await h.service.poll();

    expect(list.issues[0]?.snapshot.needsRejudge).toBe(true);
    expect(h.storage.files.get(5)?.needsRejudge).toBe(true);
    expect(h.storage.saves).toHaveLength(savesAfterRebuild);
  });

  it('lowers the mark only when resnapshot takes the snapshot again', async () => {
    const h = createHarness([makeIssue(5)]);
    h.storage.unusable.add(5);
    await h.service.poll();
    expect(h.storage.files.get(5)?.needsRejudge).toBe(true);

    const result = await h.service.resnapshot(5);

    expect(result).toMatchObject({ ok: true, snapshot: { needsRejudge: false } });
    expect(h.storage.files.get(5)?.needsRejudge).toBe(false);
    expect((await h.service.poll()).issues[0]?.snapshot.needsRejudge).toBe(false);
  });

  it('marks only the issue whose file was unusable when a first-seen issue is in the same poll', async () => {
    const h = createHarness([makeIssue(5), makeIssue(6)]);
    h.storage.unusable.add(5);

    const list = await h.service.poll();

    expect(list.issues.map((entry) => [entry.number, entry.snapshot.needsRejudge])).toEqual([
      [5, true],
      [6, false],
    ]);
    expect(h.storage.files.get(5)?.needsRejudge).toBe(true);
    expect(h.storage.files.get(6)?.needsRejudge).toBe(false);
  });

  it('marks it on the next poll when the first save failed (the unusable file is still there, so the mark is not lost)', async () => {
    const h = createHarness([makeIssue(5)]);
    h.storage.unusable.add(5);
    h.storage.failSave = () => Object.assign(new Error('no space'), { code: 'ENOSPC' });
    expect((await h.service.poll()).state).toBe('error');
    expect(h.storage.unusable.has(5)).toBe(true);
    h.storage.failSave = undefined;

    const list = await h.service.poll();

    expect(list.state).toBe('ok');
    expect(list.issues[0]?.snapshot.needsRejudge).toBe(true);
    expect(h.storage.files.get(5)?.needsRejudge).toBe(true);
  });

  it('leaves an unusable file alone when its issue is not in the list (nothing is written or removed)', async () => {
    const h = createHarness([]);
    h.storage.unusable.add(5);

    const list = await h.service.poll();

    expect(list.state).toBe('ok');
    expect(h.storage.saves).toEqual([]);
    expect(h.storage.removes).toEqual([]);
    expect(h.storage.unusable.has(5)).toBe(true);
  });

  it('is storage-failed and writes nothing when the unusable numbers cannot be read (a read error is not "no unusable file")', async () => {
    const h = createHarness([makeIssue(5)]);
    h.storage.listUnusable = () => Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    const list = await h.service.poll();

    expect(list).toMatchObject({ state: 'error', error: { kind: 'storage-failed' } });
    expect(list.error?.detail).toContain('EACCES');
    expect(h.storage.saves).toEqual([]);
  });
});
