import { describe, expect, it } from 'vitest';
import { ISSUE_DRAFT_MAX_JSON_BYTES } from '../../domain/issue-draft.js';
import { draftJsonBytes } from '../../domain/issue-draft-size.js';
import { createIssueDraftService, type ReceiveDraftInput } from './issue-draft-service.js';
import { createInMemoryIssueDraftStorage, type InMemoryIssueDraftStorage } from './issue-draft-test-support.js';

/** bdboard-4y8q.3.1: 題名・本文の編集と未処理件数 (サービス)。 */

const NOW = new Date('2026-10-04T12:00:00.000Z');

function report(letter: string): ReceiveDraftInput {
  return {
    kind: 'A',
    catalogSlug: `slug-${letter}`,
    envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' },
    project: { name: 'example-project', path: '/Users/example-user/example-project' },
  };
}

/** サービスを立て直しても (同じ保存先で) id が重ならないよう、テスト全体で数える。 */
let seq = 0;

function setup(storage: InMemoryIssueDraftStorage = createInMemoryIssueDraftStorage()) {
  const service = createIssueDraftService({
    storage,
    now: () => NOW,
    newId: () => {
      seq += 1;
      return `${1758812345000 + seq}-${seq.toString(16).padStart(16, '0')}`;
    },
    retention: { warn: () => undefined },
  });
  return { service, storage };
}

async function receive(service: ReturnType<typeof setup>['service'], letter: string): Promise<string> {
  const result = await service.receive(report(letter));
  if (!result.ok) throw new Error('receive failed');
  return result.draft.id;
}

/** 全件読み (scan と list) の回数を数える。 */
function countingScans(storage: InMemoryIssueDraftStorage): { storage: InMemoryIssueDraftStorage; scans: () => number } {
  let scans = 0;
  const scan = storage.scan.bind(storage);
  const list = storage.list.bind(storage);
  const counted: InMemoryIssueDraftStorage = {
    ...storage,
    scan: async () => {
      scans += 1;
      return scan();
    },
    list: async () => {
      scans += 1;
      return list();
    },
  };
  return { storage: counted, scans: () => scans };
}

describe('IssueDraftService.edit', () => {
  it('saves the edited title and body with the edited flags and the re-run leak scan', async () => {
    const { service, storage } = setup();
    const id = await receive(service, 'a');
    const result = await service.edit(id, { body: 'see /Users/example-user/example-project/x' });
    expect(result.ok).toBe(true);
    const stored = storage.drafts.get(id);
    expect(stored).toMatchObject({ bodyEditedByUser: true, titleEditedByUser: false });
    expect(stored?.body).toBe('see /Users/example-user/example-project/x');
    expect(stored?.suspectedLeaks?.length).toBeGreaterThan(0);
    expect(stored?.suspectedLeaks?.every((leak) => leak.field === 'body')).toBe(true);
  });

  it('keeps the edited body when the same fingerprint is received again (no regeneration over the edit)', async () => {
    const { service, storage } = setup();
    const id = await receive(service, 'a');
    await service.edit(id, { body: 'my words' });
    await receive(service, 'a');
    expect(storage.drafts.get(id)).toMatchObject({ body: 'my words', occurrenceCount: 2 });
  });

  it('refuses a draft that is not pending (409 side) and an unknown draft, writing nothing', async () => {
    const { service, storage } = setup();
    const id = await receive(service, 'a');
    await service.dismiss(id, 'not a bug');
    const before = structuredClone(storage.drafts.get(id));
    expect(await service.edit(id, { title: 'x' })).toEqual({ ok: false, reason: 'not-pending', status: 'dismissed' });
    expect(storage.drafts.get(id)).toEqual(before);
    expect(await service.edit('1758812349999-ffffffffffffffff', { title: 'x' })).toEqual({ ok: false, reason: 'not-found' });
    expect(await service.edit('../x', { title: 'x' })).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses (too-large) an edit that cannot fit 200KB even after shrinking the local fields, before the save throws', async () => {
    const { service, storage } = setup();
    const id = await receive(service, 'a');
    // 制御文字は JSON で \u0001 (6 バイト) になる。65536 文字で 384KiB。
    const result = await service.edit(id, { body: '\u0001'.repeat(65_536) });
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(storage.drafts.get(id)?.bodyEditedByUser).toBe(false);
    const fits = await service.edit(id, { body: 'b'.repeat(65_536) });
    expect(fits.ok).toBe(true);
    const saved = storage.drafts.get(id);
    expect(saved === undefined ? Infinity : draftJsonBytes(saved)).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
  });
});

describe('IssueDraftService.pendingCount', () => {
  it('counts pending drafts and follows receive, merge and dismiss', async () => {
    const { service } = setup();
    expect(await service.pendingCount()).toBe(0);
    const a = await receive(service, 'a');
    await receive(service, 'b');
    await receive(service, 'b');
    expect(await service.pendingCount()).toBe(2);
    await service.dismiss(a, 'not a bug');
    expect(await service.pendingCount()).toBe(1);
    await receive(service, 'a'); // 見送り済みへは回数だけ足す (pending に戻さない)
    expect(await service.pendingCount()).toBe(1);
  });

  it('reads every draft once, not on every call (uses the receive index)', async () => {
    const seeded = setup();
    await receive(seeded.service, 'a');
    await receive(seeded.service, 'b');
    const { storage, scans } = countingScans(seeded.storage);
    const { service } = setup(storage);
    expect(await service.pendingCount()).toBe(2);
    expect(await service.pendingCount()).toBe(2);
    await receive(service, 'c');
    expect(await service.pendingCount()).toBe(3);
    expect(scans()).toBe(1);
  });

  it('counts a dismiss made before the index was read', async () => {
    const seeded = setup();
    const a = await receive(seeded.service, 'a');
    await receive(seeded.service, 'b');
    const { service } = setup(seeded.storage);
    await service.dismiss(a, 'not a bug');
    expect(await service.pendingCount()).toBe(1);
  });

  it('does not count a posted draft as pending', async () => {
    const seeded = setup();
    const a = await receive(seeded.service, 'a');
    await receive(seeded.service, 'b');
    const stored = seeded.storage.drafts.get(a);
    if (stored !== undefined) seeded.storage.drafts.set(a, { ...stored, status: 'posted', issueNumber: 1 });
    const { service } = setup(seeded.storage);
    expect(await service.pendingCount()).toBe(1);
  });

  it('forgets a 大量発生 draft removed by hand when the next fold creates a new one', async () => {
    const { service, storage } = setup();
    for (let index = 0; index < 20; index += 1) await receive(service, `n${index}`);
    const first = await service.receive(report('over-1'));
    expect(first.ok && first.outcome).toBe('folded');
    expect(await service.pendingCount()).toBe(21);
    if (first.ok) storage.drafts.delete(first.draft.id);
    const second = await service.receive(report('over-2'));
    expect(second.ok && second.outcome).toBe('folded');
    expect(await service.pendingCount()).toBe(21);
  });

  it('forgets a pending draft that was removed by hand once the same fingerprint is received again', async () => {
    const { service, storage } = setup();
    const a = await receive(service, 'a');
    expect(await service.pendingCount()).toBe(1);
    storage.drafts.delete(a);
    await receive(service, 'a');
    expect(await service.pendingCount()).toBe(1);
  });
});
