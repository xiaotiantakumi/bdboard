import { describe, expect, it } from 'vitest';
import { ISSUE_DRAFT_MAX_JSON_BYTES } from '../../domain/issue-draft.js';
import { ISSUE_DRAFT_EDIT_HEADROOM_BYTES } from '../../domain/issue-draft-edit.js';
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
    // 制御文字は JSON で \u0001 (6 バイト) になる。65536 文字で 384KiB。見える文字が無い本文は自動へ戻る (bdboard-ov0t) ので末尾に 1 文字足す。
    const result = await service.edit(id, { body: `${'\u0001'.repeat(65_535)}x` });
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(storage.drafts.get(id)?.bodyEditedByUser).toBe(false);
    const fits = await service.edit(id, { body: 'b'.repeat(65_536) });
    expect(fits.ok).toBe(true);
    const saved = storage.drafts.get(id);
    expect(saved === undefined ? Infinity : draftJsonBytes(saved)).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
  });

  describe('leaves headroom for the next receive and dismiss (re-review m-B)', () => {
    const EDIT_LIMIT = ISSUE_DRAFT_MAX_JSON_BYTES - ISSUE_DRAFT_EDIT_HEADROOM_BYTES;
    const SYMPTOM = 's'.repeat(3000);

    function bigReport(project: { name: string; path: string }): ReceiveDraftInput {
      return {
        kind: 'A',
        catalogSlug: 'slug-big',
        symptom: SYMPTOM,
        errorText: 'e'.repeat(60_000),
        envInfo: { bdboardVersion: '0.1.2', harnessVersion: '1.0.0', os: 'darwin', nodeVersion: 'v22.14.0' },
        project,
      };
    }

    /** 生ログを削って編集の上限ぎりぎりまで膨らませた下書き (制御文字は JSON で 6 バイト)。 */
    async function editedToTheLimit() {
      const { service, storage } = setup();
      const created = await service.receive(bigReport({ name: 'proj-one', path: '/opt/proj-one' }));
      if (!created.ok) throw new Error('receive failed');
      const id = created.draft.id;
      const edited = await service.edit(id, { body: `${'\u0001'.repeat(24_999)}x` });
      expect(edited).toMatchObject({ ok: true, errorTextTrimmed: true });
      const bytes = draftJsonBytes(storage.drafts.get(id)!);
      expect(bytes).toBeLessThanOrEqual(EDIT_LIMIT);
      expect(bytes).toBeGreaterThan(EDIT_LIMIT - 64);
      return { service, storage, id };
    }

    it('a receive from another project (long path, new versions) keeps the old project and the written fields', async () => {
      const { service, storage, id } = await editedToTheLimit();
      const errorTextAfterEdit = storage.drafts.get(id)!.localOnly.errorTextRaw;
      const merged = await service.receive({
        ...bigReport({ name: 'proj-two', path: `/opt/proj-two-${'x'.repeat(980)}` }),
        envInfo: { bdboardVersion: 'v'.repeat(100), harnessVersion: 'h'.repeat(100), os: 'o'.repeat(100) },
      });
      expect(merged).toMatchObject({ ok: true, outcome: 'merged' });
      const after = storage.drafts.get(id)!;
      expect(after.occurredProjects.map((project) => project.name)).toEqual(['proj-one', 'proj-two']);
      expect(after.localOnly.symptomRaw).toBe(SYMPTOM);
      expect(after.localOnly.errorTextRaw).toBe(errorTextAfterEdit);
      expect(after.occurrenceCount).toBe(2);
    });

    it('a dismiss with a 500-character reason keeps the projects and the symptom', async () => {
      const { service, storage, id } = await editedToTheLimit();
      expect(await service.dismiss(id, 'r'.repeat(500))).toMatchObject({ ok: true });
      const after = storage.drafts.get(id)!;
      expect(after.status).toBe('dismissed');
      expect(after.occurredProjects.map((project) => project.name)).toEqual(['proj-one']);
      expect(after.localOnly.symptomRaw).toBe(SYMPTOM);
    });

    it('a draft already past the edit limit (grown by receives) takes an edit that does not grow it, and refuses one that does', async () => {
      const { service, storage } = setup();
      const wide = '\u0001'.repeat(8000);
      const created = await service.receive({
        kind: 'A',
        catalogSlug: 'slug-wide',
        symptom: wide,
        cause: wide,
        prevention: wide,
        agentNote: wide,
      });
      if (!created.ok) throw new Error('receive failed');
      const before = draftJsonBytes(storage.drafts.get(created.draft.id)!);
      expect(before).toBeGreaterThan(EDIT_LIMIT);
      // 作った本文 (版・回数・時刻の並び) より短い本文にする。疑いの欄 (空でも数十バイト) が足されても小さくなる。
      expect(created.draft.body.length).toBeGreaterThan(200);
      expect(await service.edit(created.draft.id, { body: 'Short body' })).toMatchObject({ ok: true, errorTextTrimmed: false });
      expect(draftJsonBytes(storage.drafts.get(created.draft.id)!)).toBeLessThanOrEqual(before);
      expect(await service.edit(created.draft.id, { body: 'b'.repeat(20_000) })).toEqual({ ok: false, reason: 'too-large' });
    });
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
