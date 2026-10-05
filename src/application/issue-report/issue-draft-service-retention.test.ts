import { afterEach, describe, expect, it, vi } from 'vitest';
import { ISSUE_DRAFT_RETENTION_MS } from '../../domain/issue-draft-retention.js';
import { draftJsonBytes } from '../../domain/issue-draft-size.js';
import { createIssueDraftService, type IssueDraftService } from './issue-draft-service.js';
import type { DraftRetentionOptions } from './issue-draft-retention.js';
import { createInMemoryIssueDraftStorage, type InMemoryIssueDraftStorage } from './issue-draft-test-support.js';

/**
 * bdboard-00qh: 下書きの保持期限・掃除の間隔・合計容量の上限・見送り済みへの画像追加 (サービスの層)。
 * 実ファイルでの確認 (mtime・画像・読めない下書き) は infrastructure/fs/fs-issue-draft-retention.test.ts。
 *
 * 各テストは、まず「仕込み用」のサービス (base) で下書きを作る。その受け取りで掃除が 1 回走ってしまうので、
 * 確かめる側は同じ保存先・同じ時計の上に新しいサービス (掃除の記憶が空) を立てる。
 */

const START = new Date('2026-10-04T12:00:00.000Z');
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ENV = { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' };
/** スラッグの長さをそろえて、下書き 1 件の大きさを同じにする。 */
const slug = (letter: string) => `slug-${letter}`;

interface Harness {
  readonly service: IssueDraftService;
  readonly storage: InMemoryIssueDraftStorage;
  readonly warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  /** 保存先と時計は base と共有する。 */
  readonly clock: { current: Date };
  advance(ms: number): void;
  now(): Date;
}

let idSeq = 0;

function createHarness(retention: DraftRetentionOptions = {}, base?: Harness): Harness {
  const clock = base?.clock ?? { current: new Date(START) };
  const storage = base?.storage ?? createInMemoryIssueDraftStorage(() => new Date(clock.current));
  const warn = vi.fn<(message: string) => void>();
  const service = createIssueDraftService({
    storage,
    now: () => new Date(clock.current),
    newId: () => `${1758812345000 + (idSeq += 1)}-${idSeq.toString(16).padStart(16, '0')}`,
    retention: { warn, ...retention },
  });
  return {
    service,
    storage,
    warn,
    clock,
    advance: (ms) => { clock.current = new Date(clock.current.getTime() + ms); },
    now: () => new Date(clock.current),
  };
}

async function receive(service: IssueDraftService, letter: string) {
  return service.receive({ kind: 'A', catalogSlug: slug(letter), symptom: 'symptom', envInfo: ENV });
}

async function createdId(service: IssueDraftService, letter: string): Promise<string> {
  const result = await receive(service, letter);
  if (!result.ok) throw new Error(`receive failed: ${result.reason}`);
  return result.draft.id;
}

async function dismissed(service: IssueDraftService, letter: string): Promise<string> {
  const id = await createdId(service, letter);
  const result = await service.dismiss(id, 'not a bug');
  if (!result.ok) throw new Error(`dismiss failed: ${result.reason}`);
  return id;
}

/** 最終更新を now から ageMs 前にする。 */
function age(harness: Harness, id: string, ageMs: number): void {
  harness.storage.updatedAtMs.set(id, harness.now().getTime() - ageMs);
}

/** 新しい下書き 1 件の draft.json の大きさ (スラッグの長さが同じなら、どの文字でも同じ)。 */
async function newDraftBytes(): Promise<number> {
  const probe = createHarness();
  return draftJsonBytes(probe.storage.drafts.get(await createdId(probe.service, 'z'))!);
}

function totalBytes(storage: InMemoryIssueDraftStorage): number {
  let total = 0;
  for (const draft of storage.drafts.values()) total += draftJsonBytes(draft);
  for (const forDraft of storage.images.values()) for (const image of forDraft.values()) total += image.data.byteLength;
  return total;
}

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('startup: the first receive waits for one walk of the directory, not two (bdboard-xvo2)', () => {
  it('uses the startup survey as the receive index and excludes drafts removed by pruning', async () => {
    const base = createHarness();
    await createdId(base.service, 'a');
    await createdId(base.service, 'b');
    const expired = await dismissed(base.service, 'c');
    age(base, expired, ISSUE_DRAFT_RETENTION_MS + 1);
    const h = createHarness({}, base);
    const survey = vi.spyOn(h.storage, 'survey');
    const scan = vi.spyOn(h.storage, 'scan');
    const list = vi.spyOn(h.storage, 'list');
    await Promise.all([h.service.pruneOnStart(), receive(h.service, 'new')]);
    // 修正前は survey 1 + scan 1 = 2。
    expect(survey).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(0);
    expect(list).toHaveBeenCalledTimes(0);
    expect(await h.service.pendingCount()).toBe(3);
    expect(await receive(h.service, 'a')).toMatchObject({ outcome: 'merged' });
    expect(scan).toHaveBeenCalledTimes(0);
    expect(h.storage.drafts.has(expired)).toBe(false);
  });

  it('starts with no walk when pruning has already completed', async () => {
    const h = createHarness();
    await h.service.pruneOnStart();
    const survey = vi.spyOn(h.storage, 'survey');
    const scan = vi.spyOn(h.storage, 'scan');
    const list = vi.spyOn(h.storage, 'list');
    await receive(h.service, 'first');
    expect(survey).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('does not retain an expired draft fingerprint in the seeded index', async () => {
    const base = createHarness();
    const id = await dismissed(base.service, 'expired');
    const fingerprint = base.storage.drafts.get(id)!.fingerprint;
    age(base, id, ISSUE_DRAFT_RETENTION_MS + 1);
    const h = createHarness({}, base);
    const scan = vi.spyOn(h.storage, 'scan');
    const get = vi.spyOn(h.storage, 'get');
    await h.service.pruneOnStart();
    const recreated = await h.service.receive({ kind: 'A', catalogSlug: 'slug-expired', symptom: 'symptom', envInfo: ENV });
    expect(recreated).toMatchObject({ ok: true, outcome: 'created' });
    expect(scan).not.toHaveBeenCalled();
    if (recreated.ok) expect(recreated.draft.fingerprint).toBe(fingerprint);
    expect(get).not.toHaveBeenCalledWith(id); // 索引に消した id が残っていれば、受け取りがそれを読みに行く
  });

  it('falls back to scan when the survey index seed is incomplete or absent', async () => {
    for (const seed of [{ entries: [], complete: false } as const, undefined]) {
      const h = createHarness();
      const realSurvey = h.storage.survey.bind(h.storage);
      vi.spyOn(h.storage, 'survey').mockImplementation(async () => {
        const result = await realSurvey();
        const withoutSeed = { drafts: result.drafts, totalBytes: result.totalBytes, unmeasured: result.unmeasured };
        return seed === undefined ? withoutSeed : { ...withoutSeed, indexSeed: seed };
      });
      const scan = vi.spyOn(h.storage, 'scan');
      await h.service.pruneOnStart();
      await receive(h.service, 'fallback');
      expect(scan).toHaveBeenCalledTimes(1);
      vi.resetAllMocks();
      vi.restoreAllMocks();
    }
  });

  it('does not replace an index already loaded by receive', async () => {
    const h = createHarness();
    const first = await receive(h.service, 'first');
    expect(first.ok).toBe(true);
    await h.service.pruneOnStart();
    expect(await receive(h.service, 'first')).toMatchObject({ outcome: 'merged' });
  });
});

describe('retention: terminal drafts older than 30 days are pruned on receive', () => {
  it('deletes a dismissed draft past 30 days with its images, and keeps one at exactly 30 days and one just under', async () => {
    const base = createHarness();
    const old = await dismissed(base.service, 'a');
    const exact = await dismissed(base.service, 'b');
    const under = await dismissed(base.service, 'c');
    const open = await createdId(base.service, 'z');
    await base.service.addImage(open, 'png', new Uint8Array(8)); // 開いている下書きの画像は残る
    base.storage.images.set(
      old,
      new Map([['1-aaaaaaaaaaaaaaaa.png', { entry: { fileName: '1-aaaaaaaaaaaaaaaa.png', byteLength: 3, createdAt: START }, data: Buffer.from('abc') }]]),
    );
    age(base, old, ISSUE_DRAFT_RETENTION_MS + 1);
    age(base, exact, ISSUE_DRAFT_RETENTION_MS);
    age(base, under, ISSUE_DRAFT_RETENTION_MS - 1);

    await receive(createHarness({}, base).service, 'n');

    expect(base.storage.drafts.has(old)).toBe(false);
    expect(base.storage.images.has(old)).toBe(false);
    expect(base.storage.drafts.has(exact)).toBe(true);
    expect(base.storage.drafts.has(under)).toBe(true);
    expect(base.storage.images.get(open)?.size).toBe(1);
  });

  it('prunes a posted draft the same way (the status exists in the type even though nothing sets it yet)', async () => {
    const base = createHarness();
    const id = await createdId(base.service, 'a');
    base.storage.drafts.set(id, { ...base.storage.drafts.get(id)!, status: 'posted' });
    age(base, id, 31 * DAY_MS);

    await receive(createHarness({}, base).service, 'n');

    expect(base.storage.drafts.has(id)).toBe(false);
  });

  it('never deletes a pending draft, however old', async () => {
    const base = createHarness();
    const open = await createdId(base.service, 'a');
    age(base, open, 4000 * DAY_MS);

    await receive(createHarness({}, base).service, 'n');

    expect(base.storage.drafts.get(open)?.status).toBe('pending');
  });

  it('never deletes a terminal draft it cannot read, however old', async () => {
    const base = createHarness();
    const id = await dismissed(base.service, 'a');
    age(base, id, 4000 * DAY_MS);
    base.storage.unreadable.add(id);

    await receive(createHarness({}, base).service, 'n');

    expect(base.storage.drafts.has(id)).toBe(true);
  });

  it('measures the 30 days from the last save: a count-only recurrence restarts it, an idle dismissed draft does not', async () => {
    const base = createHarness();
    const recurring = await dismissed(base.service, 'a');
    const idle = await dismissed(base.service, 'b');
    age(base, recurring, 29 * DAY_MS);
    age(base, idle, 29 * DAY_MS);
    const merged = await receive(base.service, 'a'); // 回数だけ足す保存で、最終更新が今になる
    expect(merged.ok && merged.outcome).toBe('merged');

    base.advance(29 * DAY_MS); // recurring は最後の保存から 29 日、idle は 58 日
    await receive(createHarness({}, base).service, 'n');

    expect(base.storage.drafts.has(recurring)).toBe(true);
    expect(base.storage.drafts.has(idle)).toBe(false);
  });
});

describe('retention: the prune runs at most once per hour, and at start without waiting', () => {
  it('prunes on the first receive, not again within the hour, and again once the hour has passed', async () => {
    const base = createHarness();
    const first = await dismissed(base.service, 'a');
    age(base, first, 40 * DAY_MS);
    const h = createHarness({}, base);
    const survey = vi.spyOn(h.storage, 'survey');

    await receive(h.service, 'n'); // 掃除 (1 回目)
    expect(h.storage.drafts.has(first)).toBe(false);
    expect(survey).toHaveBeenCalledTimes(1);

    const second = await dismissed(h.service, 'b');
    age(h, second, 40 * DAY_MS);
    h.advance(HOUR_MS - 1);
    await receive(h.service, 'o');
    expect(h.storage.drafts.has(second)).toBe(true);
    expect(survey).toHaveBeenCalledTimes(1);

    h.advance(1); // ちょうど 1 時間
    await receive(h.service, 'p');
    expect(h.storage.drafts.has(second)).toBe(false);
    expect(survey).toHaveBeenCalledTimes(2);
  });

  it('pruneOnStart prunes immediately, even right after a receive-triggered prune', async () => {
    const h = createHarness();
    await receive(h.service, 'n'); // 掃除済み
    const id = await dismissed(h.service, 'a');
    age(h, id, 40 * DAY_MS);

    await h.service.pruneOnStart();

    expect(h.storage.drafts.has(id)).toBe(false);
  });

  it('does not walk the directory on every receive: one survey, then the running total is used', async () => {
    const h = createHarness({ maxTotalBytes: 10_000_000 });
    const survey = vi.spyOn(h.storage, 'survey');
    for (const letter of ['a', 'b', 'c', 'd', 'e']) await receive(h.service, letter);
    await h.service.addImage(await createdId(h.service, 'f'), 'png', new Uint8Array(100));
    await receive(h.service, 'a'); // 回数だけ足す受け取り

    expect(survey).toHaveBeenCalledTimes(1);
  });
});

describe('retention: a failing prune never fails a receive, and its warning carries only codes and ids', () => {
  const failure = Object.assign(new Error('boom at /Users/example-user/secret/issue-drafts'), { code: 'EIO' });

  it('survey failing on the receive-triggered prune: the receive still creates the draft, with one code-only warning', async () => {
    const h = createHarness();
    vi.spyOn(h.storage, 'survey').mockRejectedValue(failure);

    const result = await receive(h.service, 'n');

    expect(result.ok && result.outcome).toBe('created');
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith('issue draft survey failed (EIO)');
  });

  it('survey failing with a code-less error says "unknown", and pruneOnStart still resolves', async () => {
    const h = createHarness();
    vi.spyOn(h.storage, 'survey').mockRejectedValue(new Error('no code, /Users/example-user/x'));

    await expect(h.service.pruneOnStart()).resolves.toBeUndefined();

    expect(h.warn).toHaveBeenCalledWith('issue draft survey failed (unknown)');
  });

  it('remove failing for an expired draft: the receive succeeds, the draft stays, the warning has the id and code only', async () => {
    const base = createHarness();
    const id = await dismissed(base.service, 'a');
    age(base, id, 40 * DAY_MS);
    const h = createHarness({}, base);
    vi.spyOn(h.storage, 'remove').mockRejectedValue(Object.assign(new Error('EBUSY at /Users/example-user/x'), { code: 'EBUSY' }));

    const result = await receive(h.service, 'n');

    expect(result.ok && result.outcome).toBe('created');
    expect(h.storage.drafts.has(id)).toBe(true);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith(`issue draft ${id} could not be removed (EBUSY)`);
  });

  it('does not retry a failed prune on every receive: the next try is an hour later', async () => {
    const h = createHarness();
    const survey = vi.spyOn(h.storage, 'survey').mockRejectedValue(failure);
    await receive(h.service, 'a');
    await receive(h.service, 'b');
    expect(survey).toHaveBeenCalledTimes(1);
    h.advance(HOUR_MS);
    await receive(h.service, 'c');
    expect(survey).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledTimes(2);
  });
});

describe('total size cap: terminal drafts are pruned oldest first, then a receive is refused (507 in HTTP)', () => {
  /** 見送り 2 件 (a が古い)、開いている 1 件 (c)。スラッグの長さが同じなので、開いている下書き 1 件の大きさは新しい下書きと同じ。 */
  async function seedThree() {
    const base = createHarness();
    const a = await dismissed(base.service, 'a');
    const b = await dismissed(base.service, 'b');
    const c = await createdId(base.service, 'c');
    age(base, a, 5 * DAY_MS);
    age(base, b, 3 * DAY_MS);
    return { base, a, b, c, total: totalBytes(base.storage) };
  }

  it('frees the oldest terminal draft to fit a new one, keeps the newer terminal and the open one, and accepts', async () => {
    const { base, a, b, c, total } = await seedThree();
    const h = createHarness({ maxTotalBytes: total }, base);

    const result = await receive(h.service, 'd');

    expect(result.ok && result.outcome).toBe('created');
    expect(h.storage.drafts.has(a)).toBe(false);
    expect(h.storage.drafts.has(b)).toBe(true);
    expect(h.storage.drafts.get(c)?.status).toBe('pending');
    expect(totalBytes(h.storage)).toBeLessThanOrEqual(total);
  });

  it('refuses with storage-full when only open drafts remain, deleting nothing and storing nothing', async () => {
    const base = createHarness();
    const open = [await createdId(base.service, 'a'), await createdId(base.service, 'b')];
    const h = createHarness({ maxTotalBytes: totalBytes(base.storage) }, base);

    const result = await receive(h.service, 'd');

    expect(result).toEqual({ ok: false, reason: 'storage-full' });
    expect([...h.storage.drafts.keys()].sort()).toEqual([...open].sort());
  });

  it('deletes nothing when every terminal draft together still would not make the write fit', async () => {
    const { base, a, b, c, total } = await seedThree();
    const h = createHarness({ maxTotalBytes: total }, base);

    // 見送り 2 件を足しても空かない大きさの画像 (合計の全体と同じ大きさ)。
    const result = await h.service.addImage(c, 'png', new Uint8Array(total));

    expect(result).toEqual({ ok: false, reason: 'storage-full' });
    expect(h.storage.drafts.has(a)).toBe(true);
    expect(h.storage.drafts.has(b)).toBe(true);
  });

  it('applies to image adds too: frees a terminal draft to fit the image, and refuses when it cannot', async () => {
    const base = createHarness();
    const old = await dismissed(base.service, 'a');
    const open = await createdId(base.service, 'c');
    age(base, old, 2 * DAY_MS);
    const total = totalBytes(base.storage);
    const size = draftJsonBytes(base.storage.drafts.get(old)!);
    const h = createHarness({ maxTotalBytes: total }, base);

    const fits = await h.service.addImage(open, 'png', new Uint8Array(size));
    expect(fits.ok).toBe(true);
    expect(h.storage.drafts.has(old)).toBe(false);
    expect(totalBytes(h.storage)).toBeLessThanOrEqual(total);

    const tooMuch = await h.service.addImage(open, 'png', new Uint8Array(1));
    expect(tooMuch).toEqual({ ok: false, reason: 'storage-full' });
    expect(h.storage.images.get(open)?.size).toBe(1);
  });

  it('counts a merge by its growth only: re-receiving a known report at exactly full still merges', async () => {
    const base = createHarness();
    const open = await createdId(base.service, 'a');
    const h = createHarness({ maxTotalBytes: totalBytes(base.storage) }, base);

    // 回数が 1 桁のうちは大きさが変わらない: 差分は 0。
    const merged = await receive(h.service, 'a');

    expect(merged.ok && merged.outcome).toBe('merged');
    expect(merged.ok && merged.draft.id).toBe(open);
  });

  it('keeps the cap check cheap when stuck at the cap: refused receives within a minute reuse the last survey', async () => {
    const base = createHarness();
    await createdId(base.service, 'a');
    const h = createHarness({ maxTotalBytes: totalBytes(base.storage) }, base);
    const survey = vi.spyOn(h.storage, 'survey');

    for (const letter of ['b', 'c', 'd', 'e', 'f']) {
      expect(await receive(h.service, letter)).toEqual({ ok: false, reason: 'storage-full' });
    }
    expect(survey).toHaveBeenCalledTimes(1);

    h.advance(MINUTE_MS); // 1 分たてば測り直す
    expect(await receive(h.service, 'g')).toEqual({ ok: false, reason: 'storage-full' });
    expect(survey).toHaveBeenCalledTimes(2);
  });

  it('backs the re-survey off while stuck at the cap, and a dismissal brings the next one back to a minute (bdboard-krvf)', async () => {
    const base = createHarness();
    const open = await createdId(base.service, 'a');
    await createdId(base.service, 'b');
    const h = createHarness({ maxTotalBytes: totalBytes(base.storage) }, base);
    const survey = vi.spyOn(h.storage, 'survey');

    expect(await receive(h.service, 'c')).toEqual({ ok: false, reason: 'storage-full' }); // 掃除の棚卸し 1 回 (ensureRoom は測らない)
    h.advance(MINUTE_MS);
    expect(await receive(h.service, 'd')).toEqual({ ok: false, reason: 'storage-full' }); // 張り付いたまま測り直す: 2 回目
    expect(survey).toHaveBeenCalledTimes(2);

    h.advance(MINUTE_MS); // 前回の測定から 1 分: 以前はここでも測り直した。いまは 2 分に伸びている
    expect(await receive(h.service, 'e')).toEqual({ ok: false, reason: 'storage-full' });
    expect(survey).toHaveBeenCalledTimes(2);

    // 見送ると空けられる下書きが増える: 間隔が 1 分に戻り、次の確認で測り直して、見送った下書きを消して受け取る。
    expect((await h.service.dismiss(open, 'not a bug')).ok).toBe(true);
    const result = await receive(h.service, 'f');
    expect(result.ok && result.outcome).toBe('created');
    expect(survey).toHaveBeenCalledTimes(3);
    expect(h.storage.drafts.has(open)).toBe(false);
  });

  it('accepts (fail-open) when the size cannot be measured, instead of losing the report', async () => {
    const base = createHarness();
    await createdId(base.service, 'a');
    const h = createHarness({ maxTotalBytes: 1 }, base);
    vi.spyOn(h.storage, 'survey').mockRejectedValue(Object.assign(new Error('x'), { code: 'EIO' }));

    const result = await receive(h.service, 'n');

    expect(result.ok && result.outcome).toBe('created');
  });

  it('does not refuse a dismissal because of the cap (the user finishing a draft frees room later)', async () => {
    const base = createHarness();
    const id = await createdId(base.service, 'a');
    const h = createHarness({ maxTotalBytes: totalBytes(base.storage) }, base);

    const result = await h.service.dismiss(id, 'a longer reason than before, to grow the draft');

    expect(result.ok).toBe(true);
  });

  it('is fail-open also after a survey that worked once: when the next survey fails, no stale total refuses the report', async () => {
    const base = createHarness();
    await createdId(base.service, 'a');
    const h = createHarness({ maxTotalBytes: totalBytes(base.storage) }, base);
    expect(await receive(h.service, 'b')).toEqual({ ok: false, reason: 'storage-full' }); // 測れていて、開いた下書きで満杯

    vi.spyOn(h.storage, 'survey').mockRejectedValue(Object.assign(new Error('x'), { code: 'EIO' }));
    h.advance(MINUTE_MS);
    const result = await receive(h.service, 'c');

    expect(result.ok && result.outcome).toBe('created');
    expect(h.warn).toHaveBeenCalledWith('issue draft survey failed (EIO)');
  });

  it('counts what a dismissal adds to the running total, so the next write is checked against the grown size', async () => {
    const newSize = await newDraftBytes();
    const base = createHarness();
    const id = await createdId(base.service, 'a');
    const cap = totalBytes(base.storage) + newSize + 10; // 新しい下書き 1 件と 10 バイトの余裕
    const h = createHarness({ maxTotalBytes: cap }, base);
    await h.service.pruneOnStart(); // 実測の合計を取る

    expect((await h.service.dismiss(id, 'x'.repeat(100))).ok).toBe(true); // 余裕より大きく育つ
    expect(totalBytes(h.storage) + newSize).toBeGreaterThan(cap);

    expect(await receive(h.service, 'b')).toEqual({ ok: false, reason: 'storage-full' });
  });

  it('does not count a write whose save failed: the next report is judged against the real total', async () => {
    const newSize = await newDraftBytes();
    const h = createHarness({ maxTotalBytes: newSize }); // 新しい下書き 1 件だけ入る
    await h.service.pruneOnStart();

    vi.spyOn(h.storage, 'save').mockRejectedValueOnce(new Error('disk gone'));
    await expect(receive(h.service, 'a')).rejects.toThrow('disk gone');
    const second = await receive(h.service, 'a');

    expect(second.ok && second.outcome).toBe('created');
  });
});

describe('total size cap: the draft being written is never the one freed to make room for it', () => {
  /**
   * 回数が 9 で画像つきの見送り済み (x。5 日前に最後の保存)。同じ報告がもう一度来ると回数が 10 になって
   * draft.json が 1 バイト増える (差分 +1) ので、ちょうど満杯だと空けが要る。
   */
  async function seedNineWithImage() {
    const base = createHarness();
    const x = await createdId(base.service, 'a');
    for (let count = 1; count < 9; count += 1) await receive(base.service, 'a');
    expect(base.storage.drafts.get(x)?.occurrenceCount).toBe(9);
    expect((await base.service.addImage(x, 'png', new Uint8Array(50))).ok).toBe(true);
    expect((await base.service.dismiss(x, 'not a bug')).ok).toBe(true);
    age(base, x, 5 * DAY_MS);
    return { base, x };
  }

  it('refuses a count-only merge at exactly full instead of freeing the very draft: images and count stay', async () => {
    const { base, x } = await seedNineWithImage();
    const h = createHarness({ maxTotalBytes: totalBytes(base.storage) }, base);

    const result = await receive(h.service, 'a'); // 9 -> 10: +1 バイト、空ける相手は x 自身しかいない

    expect(result).toEqual({ ok: false, reason: 'storage-full' });
    expect(h.storage.images.get(x)?.size).toBe(1);
    expect(h.storage.drafts.get(x)?.occurrenceCount).toBe(9);
  });

  it('frees another terminal draft instead: the merged draft keeps its images and the real total stays within the cap', async () => {
    const { base, x } = await seedNineWithImage();
    const y = await dismissed(base.service, 'b');
    age(base, y, 3 * DAY_MS); // x より新しい
    const cap = totalBytes(base.storage);
    const h = createHarness({ maxTotalBytes: cap }, base);

    const merged = await receive(h.service, 'a');

    expect(merged.ok && merged.outcome).toBe('merged');
    expect(h.storage.drafts.get(x)?.occurrenceCount).toBe(10);
    expect(h.storage.images.get(x)?.size).toBe(1);
    expect(h.storage.drafts.has(y)).toBe(false);
    expect(totalBytes(h.storage)).toBeLessThanOrEqual(cap);
  });
});

describe('retention: runs one at a time with the other writes', () => {
  it('pruneOnStart holds the same mutex as receive: a receive queued behind it waits for the survey to finish', async () => {
    const h = createHarness();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSurvey = h.storage.survey.bind(h.storage);
    vi.spyOn(h.storage, 'survey').mockImplementation(async () => {
      await gate;
      return realSurvey();
    });

    const prune = h.service.pruneOnStart();
    let received = false;
    const pending = receive(h.service, 'a').then((result) => {
      received = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toBe(false);
    expect(h.storage.drafts.size).toBe(0);

    release();
    await prune;
    const result = await pending;
    expect(result.ok && result.outcome).toBe('created');
  });
});

describe('retention: a clock that stepped backwards does not pause the hourly prune', () => {
  it('prunes again once the clock goes back before the last prune', async () => {
    const base = createHarness();
    const h = createHarness({}, base);
    const survey = vi.spyOn(h.storage, 'survey');
    await receive(h.service, 'a');
    expect(survey).toHaveBeenCalledTimes(1);

    h.advance(-10 * MINUTE_MS);
    await receive(h.service, 'b');

    expect(survey).toHaveBeenCalledTimes(2);
  });
});

describe('images on a finished draft', () => {
  it.each(['dismissed', 'posted'] as const)('refuses an image for a %s draft and stores nothing', async (status) => {
    const h = createHarness();
    const id = await createdId(h.service, 'a');
    h.storage.drafts.set(id, { ...h.storage.drafts.get(id)!, status });

    const result = await h.service.addImage(id, 'png', new Uint8Array(8));

    expect(result).toEqual({ ok: false, reason: 'not-pending', status });
    expect(h.storage.images.get(id)?.size ?? 0).toBe(0);
  });

  it('takes an image while the draft is pending and refuses it after the draft was dismissed through the service', async () => {
    const h = createHarness();
    const id = await createdId(h.service, 'a');
    expect((await h.service.addImage(id, 'png', new Uint8Array(8))).ok).toBe(true);
    await h.service.dismiss(id, 'not a bug');

    expect(await h.service.addImage(id, 'png', new Uint8Array(8))).toEqual({
      ok: false,
      reason: 'not-pending',
      status: 'dismissed',
    });
    expect(h.storage.images.get(id)?.size).toBe(1);
  });
});
