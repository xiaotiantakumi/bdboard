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
  it('calls onPruned once with the survey and only successfully removed ids', async () => {
    const surveyResult: DraftSurvey = { drafts: [dismissedFootprint('1-aaaaaaaaaaaaaaaa', 40, 20), dismissedFootprint('2-bbbbbbbbbbbbbbbb', 40, 20)], totalBytes: 40, unmeasured: [] };
    const storage = stubStorage(surveyResult);
    storage.remove.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    const onPruned = vi.fn();
    const retention = createDraftRetention({ storage, now: () => NOW, onPruned });
    await retention.pruneNow();
    expect(onPruned).toHaveBeenCalledTimes(1);
    expect(onPruned).toHaveBeenCalledWith(surveyResult, new Set(['2-bbbbbbbbbbbbbbbb']));
  });

  it('does not call onPruned when survey fails or during ensureRoom resurvey', async () => {
    const storage = stubStorage({ drafts: [], totalBytes: 200, unmeasured: [] });
    const onPruned = vi.fn();
    const retention = createDraftRetention({ storage, now: () => NOW, maxTotalBytes: 100, onPruned });
    storage.survey.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 'EIO' }));
    await retention.pruneNow();
    expect(onPruned).not.toHaveBeenCalled();
    await retention.ensureRoom(1);
    expect(onPruned).not.toHaveBeenCalled();
  });

  it('keeps its promise not to throw when onPruned throws: one code-only warning, the prune still counts', async () => {
    const storage = stubStorage({ drafts: [dismissedFootprint('1-aaaaaaaaaaaaaaaa', 40, 20)], totalBytes: 20, unmeasured: [] });
    const warn = vi.fn();
    const onPruned = vi.fn(() => {
      throw Object.assign(new Error('example-user private message'), { code: 'EFAULT' });
    });
    const retention = createDraftRetention({ storage, now: () => NOW, onPruned, warn });

    await expect(retention.pruneNow()).resolves.toBeUndefined();

    expect(storage.remove).toHaveBeenCalledWith('1-aaaaaaaaaaaaaaaa');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('issue draft index could not be seeded from the prune (EFAULT)');
  });

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
    nowMs += 2 * 60 * 1000; // 張り付いた (測ったのに空けられなかった) あとなので、次の測り直しは 1 分ではなく 2 分後

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

  describe('while pinned at the cap (bdboard-krvf: a survey reads every draft.json, seconds at the 1 GiB worst case)', () => {
    /**
     * 既定は、開いている下書き 1 件だけで上限ちょうど (100 バイト): 測り直しても空けられない。
     * drafts を渡すと一覧を差し替える (合計は大きさの和)。
     */
    function pinnedAtCap(options: { resurveyGapMaxMs?: number; maxTotalBytes?: number; drafts?: DraftFootprint[] } = {}) {
      const { maxTotalBytes = 100, drafts = [{ id: '1-aaaaaaaaaaaaaaaa', bytes: 100 }], ...rest } = options;
      const storage = stubStorage({ drafts, totalBytes: drafts.reduce((sum, draft) => sum + draft.bytes, 0), unmeasured: [] });
      let nowMs = NOW.getTime();
      const retention = createDraftRetention({ storage, now: () => new Date(nowMs), maxTotalBytes, warn: vi.fn(), ...rest });
      return { storage, retention, at: (elapsedMs: number) => { nowMs = NOW.getTime() + elapsedMs; } };
    }
    const HOUR = 60 * 60 * 1000;

    it('doubles the gap after each survey that could not make room, and stops at the maximum', async () => {
      const { storage, retention, at } = pinnedAtCap({ resurveyGapMaxMs: 300_000 });
      const refused = async (elapsedMs: number) => {
        at(elapsedMs);
        expect(await retention.ensureRoom(10)).toBe(false);
        return storage.survey.mock.calls.length;
      };

      expect(await refused(0)).toBe(1); // 最初は必ず測る
      expect(await refused(60_000)).toBe(1); // 測っていない拒否は、間隔を伸ばさない
      expect(await refused(119_999)).toBe(1); // 1 回張り付いた: 次は 2 分後
      expect(await refused(120_000)).toBe(2);
      expect(await refused(359_999)).toBe(2); // 2 回: 次は 4 分後
      expect(await refused(360_000)).toBe(3);
      expect(await refused(659_999)).toBe(3); // 3 回: 8 分ではなく上限の 5 分
      expect(await refused(660_000)).toBe(4);
      expect(await refused(959_999)).toBe(4); // 上限のまま
      expect(await refused(960_000)).toBe(5);
    });

    it('stops doubling at one hour by default', async () => {
      const { storage, retention, at } = pinnedAtCap();
      const MINUTE = 60_000;
      // 測る時刻: 0 → +2 分 → +4 分 → +8 分 → +16 分 → +32 分。その次は +64 分ではなく上限の +1 時間。
      const surveyAt = [0, 2 * MINUTE, 6 * MINUTE, 14 * MINUTE, 30 * MINUTE, 62 * MINUTE];
      for (const [index, elapsed] of surveyAt.entries()) {
        at(elapsed - 1); // 1 ミリ秒早い: 測らない
        if (index > 0) await retention.ensureRoom(10);
        expect(storage.survey).toHaveBeenCalledTimes(index);
        at(elapsed);
        expect(await retention.ensureRoom(10)).toBe(false);
        expect(storage.survey).toHaveBeenCalledTimes(index + 1);
      }
      at(62 * MINUTE + HOUR - 1);
      await retention.ensureRoom(10);
      expect(storage.survey).toHaveBeenCalledTimes(6);
      at(62 * MINUTE + HOUR);
      await retention.ensureRoom(10);
      expect(storage.survey).toHaveBeenCalledTimes(7);
    });

    it('never goes below the base gap when the maximum is configured smaller than it', async () => {
      const { storage, retention, at } = pinnedAtCap({ resurveyGapMaxMs: 1000 });
      await retention.ensureRoom(10);
      at(59_999);
      await retention.ensureRoom(10);
      expect(storage.survey).toHaveBeenCalledTimes(1);
      at(60_000);
      await retention.ensureRoom(10);
      expect(storage.survey).toHaveBeenCalledTimes(2);
      at(120_000); // 伸びない: 次も 1 分後
      await retention.ensureRoom(10);
      expect(storage.survey).toHaveBeenCalledTimes(3);
    });

    it('goes back to the base gap after noteFreeableDraft (a dismissal can make a draft freeable)', async () => {
      const { storage, retention, at } = pinnedAtCap();
      await retention.ensureRoom(10); // 測る (1 回目)
      at(120_000);
      await retention.ensureRoom(10); // 測る (2 回目): 次は 4 分後
      at(180_000);
      await retention.ensureRoom(10);
      expect(storage.survey).toHaveBeenCalledTimes(2); // 1 分では測らない

      retention.noteFreeableDraft();
      expect(storage.survey).toHaveBeenCalledTimes(2); // 呼んだだけでは測らない
      expect(await retention.ensureRoom(10)).toBe(false);
      expect(storage.survey).toHaveBeenCalledTimes(3); // 最後の測定から 1 分たっているので、次の確認で測る
    });

    it('goes back to the base gap once a survey finds room, so a later pin starts from one minute again', async () => {
      const { storage, retention, at } = pinnedAtCap();
      await retention.ensureRoom(10); // 測る (1 回目): 張り付いた
      storage.survey.mockResolvedValue({ drafts: [{ id: '1-aaaaaaaaaaaaaaaa', bytes: 50 }], totalBytes: 50, unmeasured: [] });
      at(120_000);
      expect(await retention.ensureRoom(10)).toBe(true); // 外で消された: 空いた
      retention.recordWrite(50); // また満杯

      at(180_000); // 最後の測定から 1 分
      expect(await retention.ensureRoom(10)).toBe(true);
      expect(storage.survey).toHaveBeenCalledTimes(3); // 戻っていなければ 4 分待つはず
    });

    it('goes back to the base gap when a survey fails (fail-open: nothing is pinned)', async () => {
      const { storage, retention, at } = pinnedAtCap();
      await retention.ensureRoom(10); // 張り付いた (次は 2 分後)
      storage.survey.mockRejectedValue(Object.assign(new Error('x'), { code: 'EIO' }));
      at(120_000);
      expect(await retention.ensureRoom(10)).toBe(true); // 測れず通す
      at(180_000);
      expect(await retention.ensureRoom(10)).toBe(true);
      expect(storage.survey).toHaveBeenCalledTimes(3); // 失敗のあとは 1 分で試す
    });

    it('does not go back to the base gap for a write that fits at once: a small write passing must not undo the backoff of a large one', async () => {
      const { storage, retention, at } = pinnedAtCap({ maxTotalBytes: 110 }); // 合計 100: 5 バイトは入り、20 バイトは入らない
      expect(await retention.ensureRoom(20)).toBe(false); // 測る (1 回目): 張り付いた。次は 2 分後
      at(1000);
      expect(await retention.ensureRoom(5)).toBe(true); // 早い道: 測らずに通す。間隔は戻さない
      at(60_000);
      expect(await retention.ensureRoom(20)).toBe(false);
      expect(storage.survey).toHaveBeenCalledTimes(1); // 戻していれば、ここで測り直している
      at(120_000);
      expect(await retention.ensureRoom(20)).toBe(false);
      expect(storage.survey).toHaveBeenCalledTimes(2);
    });

    it('goes back to the base gap when room comes from the last survey list without a new survey', async () => {
      const { storage, retention, at } = pinnedAtCap({
        drafts: [dismissedFootprint('1-aaaaaaaaaaaaaaaa', 9, 50), { id: '2-bbbbbbbbbbbbbbbb', bytes: 50 }],
      });
      // 空けられるのは今書いている下書き自身だけ: 測ったのに空けられず、張り付いた (次は 2 分後)。
      expect(await retention.ensureRoom(10, '1-aaaaaaaaaaaaaaaa')).toBe(false);
      at(1000); // 2 分の間隔の内側: 測らない
      expect(await retention.ensureRoom(10)).toBe(true); // 直近の一覧にある見送り済みを消して空ける (新しい測定なし)
      expect(storage.survey).toHaveBeenCalledTimes(1);
      expect(storage.remove).toHaveBeenCalledWith('1-aaaaaaaaaaaaaaaa');
      retention.recordWrite(50); // また満杯

      at(60_000); // 最初の測定から 1 分
      await retention.ensureRoom(10);
      expect(storage.survey).toHaveBeenCalledTimes(2); // 戻っていなければ 2 分待つはず
    });

    it('goes back to the base gap when the hourly prune finds the directory smaller than it was tracked (deleted by hand)', async () => {
      const { storage, retention, at } = pinnedAtCap();
      await retention.ensureRoom(10); // 測る (1 回目)
      at(120_000);
      await retention.ensureRoom(10); // 測る (2 回目): 次は 4 分後
      // 手で消された: 掃除の棚卸しは、持っていた合計 (100) より小さい 50 を実測する。
      storage.survey.mockResolvedValue({ drafts: [{ id: '1-aaaaaaaaaaaaaaaa', bytes: 50 }], totalBytes: 50, unmeasured: [] });
      at(HOUR);
      await retention.pruneNow();
      expect(storage.survey).toHaveBeenCalledTimes(3);

      // 暴走がまた満杯にした。
      storage.survey.mockResolvedValue({ drafts: [{ id: '1-aaaaaaaaaaaaaaaa', bytes: 100 }], totalBytes: 100, unmeasured: [] });
      retention.recordWrite(50);
      at(HOUR + 60_000);
      expect(await retention.ensureRoom(10)).toBe(false);
      expect(storage.survey).toHaveBeenCalledTimes(4); // 戻っていなければ 4 分待つはず
    });

    it('goes back to the base gap when the prune removes an expired draft', async () => {
      const { storage, retention, at } = pinnedAtCap({
        drafts: [dismissedFootprint('1-aaaaaaaaaaaaaaaa', 40, 50), { id: '2-bbbbbbbbbbbbbbbb', bytes: 50 }],
      });
      expect(await retention.ensureRoom(10, '1-aaaaaaaaaaaaaaaa')).toBe(false); // 張り付いた (次は 2 分後)
      at(60_000);
      await retention.pruneNow(); // 期限 (30 日) を過ぎた 1 件を消す。実測の合計は持っていた合計と同じ 100
      expect(storage.remove).toHaveBeenCalledWith('1-aaaaaaaaaaaaaaaa');
      expect(storage.survey).toHaveBeenCalledTimes(2);

      retention.recordWrite(50); // また満杯
      at(120_000); // 掃除の測定から 1 分
      await retention.ensureRoom(10);
      expect(storage.survey).toHaveBeenCalledTimes(3); // 戻っていなければ、掃除の測定から 2 分待つはず
    });

    it('keeps the stretched gap after a prune that freed nothing, so the backoff does not restart every hour', async () => {
      const { storage, retention, at } = pinnedAtCap();
      await retention.ensureRoom(10); // 測る (1 回目)
      at(120_000);
      await retention.ensureRoom(10); // 測る (2 回目): 次は 4 分後
      at(HOUR);
      await retention.pruneNow(); // 測る (3 回目): 合計は 100 のまま、期限切れも無い
      expect(storage.survey).toHaveBeenCalledTimes(3);

      at(HOUR + 60_000);
      expect(await retention.ensureRoom(10)).toBe(false);
      expect(storage.survey).toHaveBeenCalledTimes(3); // 戻していれば、ここで測り直している
      at(HOUR + 240_000 - 1);
      await retention.ensureRoom(10);
      expect(storage.survey).toHaveBeenCalledTimes(3);
      at(HOUR + 240_000); // 間隔は 4 分のまま
      await retention.ensureRoom(10);
      expect(storage.survey).toHaveBeenCalledTimes(4);
    });
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
