import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DraftFootprint } from '../../domain/issue-draft-retention.js';
import type { DraftSurvey, IssueDraftStoragePort } from '../ports/issue-draft-storage.js';
import { createDraftRetention } from './issue-draft-retention.js';

/** bdboard-00qh: 掃除と容量の確認の分岐のうち、サービス経由では作りにくいもの (部分的な削除の失敗・測り損ねの警告)。 */

const NOW = new Date('2026-10-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function dismissedFootprint(id: string, ageDays: number, bytes: number): DraftFootprint {
  return { id, bytes, known: { status: 'dismissed', updatedAtMs: NOW.getTime() - ageDays * DAY_MS } };
}

function stubStorage(survey: DraftSurvey) {
  return {
    survey: vi.fn<IssueDraftStoragePort['survey']>().mockResolvedValue(survey),
    remove: vi.fn<IssueDraftStoragePort['remove']>().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('createDraftRetention', () => {
  it('refuses when a removal fails and the ones that did go are not enough, warning with the id and code only', async () => {
    const storage = stubStorage({
      drafts: [dismissedFootprint('1-aaaaaaaaaaaaaaaa', 9, 60), dismissedFootprint('2-bbbbbbbbbbbbbbbb', 5, 60)],
      totalBytes: 120,
      unmeasured: [],
    });
    storage.remove.mockImplementation((id) =>
      id === '1-aaaaaaaaaaaaaaaa'
        ? Promise.reject(Object.assign(new Error('EBUSY at /Users/example-user/x'), { code: 'EBUSY' }))
        : Promise.resolve(),
    );
    const warn = vi.fn();
    const retention = createDraftRetention({ storage, now: () => NOW, maxTotalBytes: 120, warn });

    // 100 バイト足したい = 100 バイト空ける必要がある。古い順に 2 件選ぶが、片方が消せない。
    expect(await retention.ensureRoom(100)).toBe(false);

    expect(storage.remove).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('issue draft 1-aaaaaaaaaaaaaaaa could not be removed (EBUSY)');
  });

  it('accepts after the removal succeeds and counts the freed bytes against the running total', async () => {
    const storage = stubStorage({
      drafts: [dismissedFootprint('1-aaaaaaaaaaaaaaaa', 9, 60), dismissedFootprint('2-bbbbbbbbbbbbbbbb', 5, 60)],
      totalBytes: 120,
      unmeasured: [],
    });
    const retention = createDraftRetention({ storage, now: () => NOW, maxTotalBytes: 120, warn: vi.fn() });

    expect(await retention.ensureRoom(60)).toBe(true);
    expect(storage.remove.mock.calls.map(([id]) => id)).toEqual(['1-aaaaaaaaaaaaaaaa']);
    retention.recordWrite(60); // 書いたあとの合計は上限ちょうど
    expect(await retention.ensureRoom(1)).toBe(true); // 残る見送り 1 件を消して空ける
    expect(storage.remove.mock.calls.map(([id]) => id)).toEqual(['1-aaaaaaaaaaaaaaaa', '2-bbbbbbbbbbbbbbbb']);
  });

  it('says once, with codes only, that sizes are undercounted when a survey could not measure some locations', async () => {
    const storage = stubStorage({ drafts: [], totalBytes: 10, unmeasured: ['EIO', 'EIO', 'ENOTDIR'] });
    const warn = vi.fn();
    const retention = createDraftRetention({ storage, now: () => NOW, warn });

    await retention.pruneNow();
    await retention.pruneNow();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('issue draft sizes are undercounted: 3 location(s) could not be measured (EIO, ENOTDIR)');
  });

  it('still prunes expired drafts when sizes are undercounted (an unmeasured location counts as 0 bytes)', async () => {
    const storage = stubStorage({
      drafts: [dismissedFootprint('1-aaaaaaaaaaaaaaaa', 40, 10)],
      totalBytes: 10,
      unmeasured: ['EIO'],
    });
    const retention = createDraftRetention({ storage, now: () => NOW, maxTotalBytes: 15, warn: vi.fn() });

    await retention.pruneNow();

    expect(storage.remove).toHaveBeenCalledWith('1-aaaaaaaaaaaaaaaa');
  });

  it('treats a non-positive increment as always fitting, without measuring', async () => {
    const storage = stubStorage({ drafts: [], totalBytes: 0, unmeasured: [] });
    const retention = createDraftRetention({ storage, now: () => NOW, maxTotalBytes: 0, warn: vi.fn() });

    expect(await retention.ensureRoom(0)).toBe(true);
    expect(await retention.ensureRoom(-5)).toBe(true);
    expect(storage.survey).not.toHaveBeenCalled();
  });

  it('never frees the draft being written (keepId), even when it is the oldest terminal one', async () => {
    const storage = stubStorage({
      drafts: [dismissedFootprint('1-aaaaaaaaaaaaaaaa', 9, 60), dismissedFootprint('2-bbbbbbbbbbbbbbbb', 5, 60)],
      totalBytes: 120,
      unmeasured: [],
    });
    const retention = createDraftRetention({ storage, now: () => NOW, maxTotalBytes: 120, warn: vi.fn() });

    expect(await retention.ensureRoom(10, '1-aaaaaaaaaaaaaaaa')).toBe(true);
    expect(storage.remove.mock.calls.map(([id]) => id)).toEqual(['2-bbbbbbbbbbbbbbbb']);

    // 残りが書き込み中の下書きだけなら、空けられない: 消さずに断る。
    retention.recordWrite(60); // 合計はまた上限ちょうど (X の 60 + 書いた 60)
    expect(await retention.ensureRoom(10, '1-aaaaaaaaaaaaaaaa')).toBe(false);
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });

  it('is fail-open after a survey that worked once and then fails: the old total and list are dropped', async () => {
    const storage = stubStorage({ drafts: [dismissedFootprint('1-aaaaaaaaaaaaaaaa', 9, 60)], totalBytes: 120, unmeasured: [] });
    let nowMs = NOW.getTime();
    const warn = vi.fn();
    const retention = createDraftRetention({ storage, now: () => new Date(nowMs), maxTotalBytes: 100, warn });
    storage.remove.mockRejectedValue(Object.assign(new Error('x'), { code: 'EBUSY' }));
    expect(await retention.ensureRoom(10)).toBe(false); // 測れていて、上限を超え、消せない

    storage.survey.mockRejectedValue(Object.assign(new Error('x'), { code: 'EIO' }));
    nowMs += 60 * 1000;

    expect(await retention.ensureRoom(10)).toBe(true);
    expect(warn).toHaveBeenCalledWith('issue draft survey failed (EIO)');
    // 失敗した直後の 1 分は、また測りに行かずに通す。
    expect(await retention.ensureRoom(10)).toBe(true);
    expect(storage.survey).toHaveBeenCalledTimes(2);
  });

  it('treats a clock that stepped backwards as due, for the hourly prune and for the re-survey', async () => {
    const storage = stubStorage({ drafts: [], totalBytes: 100, unmeasured: [] });
    let nowMs = NOW.getTime();
    const retention = createDraftRetention({ storage, now: () => new Date(nowMs), maxTotalBytes: 100, warn: vi.fn() });

    await retention.pruneIfDue();
    nowMs -= 10 * 60 * 1000; // 前回の掃除より前の時刻
    await retention.pruneIfDue();
    expect(storage.survey).toHaveBeenCalledTimes(2);

    expect(await retention.ensureRoom(10)).toBe(false); // 直前の棚卸しから 0 ミリ秒: 測り直さない
    expect(storage.survey).toHaveBeenCalledTimes(2);
    nowMs -= 1000;
    expect(await retention.ensureRoom(10)).toBe(false); // 時計が戻った: 測り直す
    expect(storage.survey).toHaveBeenCalledTimes(3);
  });

  it('uses the injected limits: retention period, prune interval and cap', async () => {
    const storage = stubStorage({
      drafts: [dismissedFootprint('1-aaaaaaaaaaaaaaaa', 2, 10), dismissedFootprint('2-bbbbbbbbbbbbbbbb', 0.5, 10)],
      totalBytes: 20,
      unmeasured: [],
    });
    let nowMs = NOW.getTime();
    const retention = createDraftRetention({
      storage,
      now: () => new Date(nowMs),
      retentionMs: DAY_MS, // 1 日
      pruneIntervalMs: 1000,
      warn: vi.fn(),
    });

    await retention.pruneIfDue();
    expect(storage.remove.mock.calls.map(([id]) => id)).toEqual(['1-aaaaaaaaaaaaaaaa']);

    nowMs += 999;
    await retention.pruneIfDue();
    expect(storage.survey).toHaveBeenCalledTimes(1);
    nowMs += 1;
    await retention.pruneIfDue();
    expect(storage.survey).toHaveBeenCalledTimes(2);
  });
});
