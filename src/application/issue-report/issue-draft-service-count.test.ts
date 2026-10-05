import { describe, expect, it, vi } from 'vitest';
import { ISSUE_DRAFT_RETENTION_MS } from '../../domain/issue-draft-retention.js';
import { createIssueDraftService, type ReceiveDraftInput } from './issue-draft-service.js';
import { createInMemoryIssueDraftStorage, type InMemoryIssueDraftStorage } from './issue-draft-test-support.js';

/**
 * bdboard-vsuc: 未処理件数の数え方。一覧 (listWithPendingCount) と pendingCount() が同じ数を返し、手で消された・足された
 * 下書きが一覧を読んだときに合い、欠けた一覧のあいだは全件を読み直し続けず、掃除が消した下書きは索引から落ちる。
 * サーバーの外の変更は storage.drafts を直接触って再現する。
 */

const START = new Date('2026-10-04T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

let seq = 0;

function setup(storage?: InMemoryIssueDraftStorage) {
  const clock = { current: new Date(START) };
  const store = storage ?? createInMemoryIssueDraftStorage(() => new Date(clock.current));
  const service = createIssueDraftService({
    storage: store,
    now: () => new Date(clock.current),
    newId: () => {
      seq += 1;
      return `${1758812345000 + seq}-${seq.toString(16).padStart(16, '0')}`;
    },
    retention: { warn: () => undefined },
  });
  return { service, storage: store, advance: (ms: number) => void (clock.current = new Date(clock.current.getTime() + ms)) };
}

function report(slug: string): ReceiveDraftInput {
  return { kind: 'A', catalogSlug: slug, symptom: 'symptom', envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' } };
}

async function receive(service: ReturnType<typeof setup>['service'], slug: string) {
  const result = await service.receive(report(slug));
  if (!result.ok) throw new Error(`receive failed: ${result.reason}`);
  return result.draft;
}

describe('the list count and pendingCount() agree after the drafts were changed outside the server', () => {
  it('drops a pending draft that was removed by hand once the list is read (and not before: the index does not watch the files)', async () => {
    const { service, storage } = setup();
    const one = await receive(service, 'one');
    await receive(service, 'two');
    storage.drafts.delete(one.id);

    expect(await service.pendingCount()).toBe(2);
    const listing = await service.listWithPendingCount();
    expect(listing.pendingCount).toBe(1);
    expect(listing.drafts).toHaveLength(1);
    expect(await service.pendingCount()).toBe(1);
  });

  it('counts a pending draft that was added by hand once the list is read', async () => {
    const { service, storage } = setup();
    await receive(service, 'one');
    const copy = { ...(await receive(service, 'two')), id: '1758812345999-ffffffffffffffff', fingerprint: 'hand-added' };
    storage.drafts.set(copy.id, copy);

    expect(await service.pendingCount()).toBe(2);
    expect((await service.listWithPendingCount()).pendingCount).toBe(3);
    expect(await service.pendingCount()).toBe(3);
  });

  it('follows a status that was changed by hand (a pending draft marked posted)', async () => {
    const { service, storage } = setup();
    const one = await receive(service, 'one');
    await receive(service, 'two');
    storage.drafts.set(one.id, { ...one, status: 'posted', issueNumber: 1 });

    expect((await service.listWithPendingCount()).pendingCount).toBe(1);
    expect(await service.pendingCount()).toBe(1);
  });

  it('reconciles on list() too, not only on listWithPendingCount()', async () => {
    const { service, storage } = setup();
    const one = await receive(service, 'one');
    await receive(service, 'two');
    storage.drafts.delete(one.id);

    expect(await service.list()).toHaveLength(1);
    expect(await service.pendingCount()).toBe(1);
  });

  it('keeps both numbers equal through dismiss, merge and receive', async () => {
    const { service } = setup();
    const one = await receive(service, 'one');
    await receive(service, 'two');
    await receive(service, 'two');
    await service.dismiss(one.id, 'not a bug');
    const listing = await service.listWithPendingCount();
    expect(listing.pendingCount).toBe(1);
    expect(await service.pendingCount()).toBe(1);
    expect(listing.drafts.map((draft) => draft.status).sort()).toEqual(['dismissed', 'pending']);
  });

  it('counts the pending ones of the very list it returns (a draft that is not in the index yet included)', async () => {
    const seeded = setup();
    await receive(seeded.service, 'one');
    const { service } = setup(seeded.storage); // 索引をまだ読んでいない
    expect((await service.listWithPendingCount()).pendingCount).toBe(1);
    expect(await service.pendingCount()).toBe(1);
  });

  it('does not read the index in order to list (reading the list alone never loads it)', async () => {
    const seeded = setup();
    await receive(seeded.service, 'one');
    const { service, storage } = setup(seeded.storage);
    const scan = vi.spyOn(storage, 'scan');
    await service.list();
    expect(scan).toHaveBeenCalledTimes(1);
    await service.pendingCount(); // 索引はここで初めて読む
    expect(scan).toHaveBeenCalledTimes(2);
  });
});

describe('a write that overlaps the read of the list is not undone by it', () => {
  it('skips the reconciliation when a receive wrote to the index while the old list was still being read', async () => {
    const { service, storage } = setup();
    await receive(service, 'old');
    const realScan = storage.scan.bind(storage);
    let reached!: () => void;
    const reachedScan = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // 一覧の読みを、新しい受け取りの前の中身で止めて、あとから返す。
    vi.spyOn(storage, 'scan').mockImplementationOnce(async () => {
      const stale = await realScan();
      reached();
      await gate;
      return stale;
    });

    const listing = service.listWithPendingCount();
    await reachedScan;
    const fresh = await receive(service, 'fresh');
    release();
    const result = await listing;

    expect(result.drafts.map((draft) => draft.id)).not.toContain(fresh.id); // 返す一覧は読んだ時点のもの
    expect(result.pendingCount).toBe(1);
    expect(await service.pendingCount()).toBe(2); // 索引は新しい受け取りを失わない
  });

  it('skips the reconciliation when a dismiss wrote to the index while the old list was still being read', async () => {
    const { service, storage } = setup();
    const one = await receive(service, 'one');
    await receive(service, 'two');
    const realScan = storage.scan.bind(storage);
    let reached!: () => void;
    const reachedScan = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(storage, 'scan').mockImplementationOnce(async () => {
      const stale = await realScan();
      reached();
      await gate;
      return stale; // 見送りの前の (one が pending の) 一覧
    });

    const listing = service.listWithPendingCount();
    await reachedScan;
    await service.dismiss(one.id, 'not a bug');
    release();
    expect((await listing).pendingCount).toBe(2);
    expect(await service.pendingCount()).toBe(1);
  });
});

describe('an incomplete listing', () => {
  it('does not remove the drafts it could not read from the count', async () => {
    const { service, storage } = setup();
    await receive(service, 'one');
    const two = await receive(service, 'two');
    const realScan = storage.scan.bind(storage);
    vi.spyOn(storage, 'scan').mockImplementation(async () => {
      const listing = await realScan();
      return { drafts: listing.drafts.filter((draft) => draft.id !== two.id), complete: false };
    });

    const listing = await service.listWithPendingCount();
    expect(listing.drafts).toHaveLength(1);
    expect(listing.pendingCount).toBe(1); // 返した一覧そのものの数
    expect(await service.pendingCount()).toBe(2); // 読めなかっただけの下書きは数に残る
  });
});

describe('pendingCount() while the listing stays incomplete', () => {
  /** 受け取りの掃除が索引を置かない (材料なし) うえ、一覧がずっと欠ける保存先。 */
  function incompleteSetup() {
    const base = setup();
    const realScan = base.storage.scan.bind(base.storage);
    vi.spyOn(base.storage, 'survey').mockImplementation(async () => ({ drafts: [], totalBytes: 0, unmeasured: [] }));
    const scan = vi.spyOn(base.storage, 'scan').mockImplementation(async () => ({ ...(await realScan()), complete: false }));
    return { ...base, scan };
  }

  it('reads the drafts once and reuses that for 30 seconds, then reads again', async () => {
    const { service, storage, advance, scan } = incompleteSetup();
    const stored = await receive(setup().service, 'stored'); // 別の保存先で作った下書きを、この保存先へ手で置く
    storage.drafts.set(stored.id, stored);

    expect(await service.pendingCount()).toBe(1);
    expect(await service.pendingCount()).toBe(1);
    expect(scan).toHaveBeenCalledTimes(1); // 修正前は呼ぶたびに 1 回
    advance(29_000);
    await service.pendingCount();
    expect(scan).toHaveBeenCalledTimes(1);
    advance(1_001);
    await service.pendingCount();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('still reads the drafts on every receive, and the count then includes what the receive wrote', async () => {
    const { service, scan } = incompleteSetup();
    await receive(service, 'one');
    expect(scan).toHaveBeenCalledTimes(1);
    await receive(service, 'two');
    expect(scan).toHaveBeenCalledTimes(2);
    await receive(service, 'two'); // 併合
    expect(scan).toHaveBeenCalledTimes(3);
    expect(await service.pendingCount()).toBe(2);
    expect(scan).toHaveBeenCalledTimes(3); // 受け取りが作った索引を件数の問い合わせが使い回す
  });

  it('follows a dismiss at once: the dismiss writes into the incomplete index that the count reuses', async () => {
    const { service, scan } = incompleteSetup();
    const one = await receive(service, 'one');
    await receive(service, 'two');
    expect(await service.pendingCount()).toBe(2);
    await service.dismiss(one.id, 'not a bug');
    expect(await service.pendingCount()).toBe(1); // 反映しないと、使い回す 30 秒のあいだ 2 のまま (一覧は 1)
    expect(scan).toHaveBeenCalledTimes(2); // 読み直さずに合う
  });
});

describe('drafts removed by the retention are dropped from the index', () => {
  it('does not look up the removed draft by its id when the same report comes again, and the count stays right', async () => {
    const { service, storage, advance } = setup();
    const expired = await receive(service, 'same');
    await service.dismiss(expired.id, 'not a bug');
    advance(ISSUE_DRAFT_RETENTION_MS + HOUR_MS + 1);

    await receive(service, 'other'); // 1 時間を過ぎているので、この受け取りの掃除が期限切れの下書きを消す
    expect(storage.drafts.has(expired.id)).toBe(false);
    const get = vi.spyOn(storage, 'get');
    const again = await service.receive(report('same'));

    expect(again).toMatchObject({ ok: true, outcome: 'created' });
    if (again.ok) expect(again.draft.id).not.toBe(expired.id);
    // 索引に消えた下書きの指紋が残っていれば、受け取りがその id を読みに行く (修正前)。
    expect(get).not.toHaveBeenCalledWith(expired.id);
    expect(await service.pendingCount()).toBe(2);
    expect((await service.listWithPendingCount()).pendingCount).toBe(2);
  });
});
