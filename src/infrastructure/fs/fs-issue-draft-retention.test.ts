import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIssueDraftService, type IssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import type { DraftRetentionOptions } from '../../application/issue-report/issue-draft-retention.js';
import { ISSUE_DRAFT_RETENTION_MS } from '../../domain/issue-draft-retention.js';
import { draftJsonBytes } from '../../domain/issue-draft-size.js';
import type { IssueDraft } from '../../domain/issue-draft.js';
import type { IssueDraftStoragePort } from '../../application/ports/issue-draft-storage.js';
import { createFsIssueDraftStorage } from './fs-issue-draft-storage.js';

/**
 * bdboard-00qh: 保持期限と合計容量を、実ファイル (mtime・画像・読めない下書き) と注入した時計で確かめる。
 * 時刻は秒の整数にそろえる (utimes の丸めで境界がぶれないように)。
 */

const NOW = new Date('2026-10-04T12:00:00.000Z');
const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_OLD = '1758812345001-a1b2c3d4e5f6a7b8';
const ID_EXACT = '1758812345002-a1b2c3d4e5f6a7b8';
const ID_UNDER = '1758812345003-a1b2c3d4e5f6a7b8';
const ID_OPEN = '1758812345004-a1b2c3d4e5f6a7b8';
const ID_BAD = '1758812345005-a1b2c3d4e5f6a7b8';

function makeDraft(id: string, overrides: Partial<IssueDraft> = {}): IssueDraft {
  return {
    id,
    kind: 'A',
    fingerprint: `A:slug-${id}`,
    title: 'title',
    body: 'body',
    titleEditedByUser: false,
    bodyEditedByUser: false,
    localOnly: {
      symptomRaw: 'symptom',
      causeRaw: 'cause',
      preventionRaw: 'prevention',
      errorTextTruncated: false,
      envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' },
    },
    occurredProjects: [],
    occurrenceCount: 1,
    firstOccurredAt: '2026-08-01T00:00:00.000Z',
    lastOccurredAt: '2026-08-01T00:00:00.000Z',
    status: 'dismissed',
    dismissReason: 'not a bug',
    draftSchemaVersion: 1,
    ...overrides,
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('retention and the size cap on real files', () => {
  let baseDir: string;
  let current: Date;
  let seq: number;

  beforeEach(async () => {
    baseDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-issue-drafts-retention-')), 'issue-drafts');
    current = new Date(NOW);
    seq = 0;
  });

  afterEach(async () => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    await fs.rm(path.dirname(baseDir), { recursive: true, force: true });
  });

  function setup(retention: DraftRetentionOptions = {}, storageOptions: Parameters<typeof createFsIssueDraftStorage>[1] = {}) {
    const warn = vi.fn();
    const storage = createFsIssueDraftStorage(baseDir, { warn: () => undefined, ...storageOptions });
    const service: IssueDraftService = createIssueDraftService({
      storage,
      now: () => new Date(current),
      newId: () => `${1758812346000 + (seq += 1)}-d1b2c3d4e5f6a7b8`,
      retention: { warn, ...retention },
    });
    return { storage, service, warn };
  }

  /** draft.json を書いて、最終更新を NOW から ageMs 前にする。 */
  async function seed(storage: IssueDraftStoragePort, draft: IssueDraft, ageMs: number, imageCount = 0): Promise<void> {
    await storage.save(draft);
    for (let index = 0; index < imageCount; index += 1) await storage.saveImage(draft.id, 'png', PNG);
    const when = new Date(NOW.getTime() - ageMs);
    await fs.utimes(path.join(baseDir, draft.id, 'draft.json'), when, when);
  }

  async function exists(id: string): Promise<boolean> {
    return fs.access(path.join(baseDir, id)).then(() => true, () => false);
  }

  async function receiveOne(service: IssueDraftService, slug = 'n') {
    return service.receive({ kind: 'A', catalogSlug: slug, symptom: 's', envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' } });
  }

  it('deletes a dismissed draft 30 days and one second old with its images, keeps exactly 30 days, just under, and open ones', async () => {
    const { storage, service } = setup();
    await seed(storage, makeDraft(ID_OLD), ISSUE_DRAFT_RETENTION_MS + SECOND_MS, 2);
    await seed(storage, makeDraft(ID_EXACT), ISSUE_DRAFT_RETENTION_MS, 1);
    await seed(storage, makeDraft(ID_UNDER), ISSUE_DRAFT_RETENTION_MS - SECOND_MS, 1);
    await seed(storage, makeDraft(ID_OPEN, { status: 'pending', dismissReason: undefined }), 400 * DAY_MS, 1);

    const result = await receiveOne(service);

    expect(result.ok && result.outcome).toBe('created');
    expect(await exists(ID_OLD)).toBe(false);
    expect(await exists(ID_EXACT)).toBe(true);
    expect(await exists(ID_UNDER)).toBe(true);
    expect(await exists(ID_OPEN)).toBe(true);
    expect(await storage.countImages(ID_EXACT)).toBe(1);
    expect(await storage.countImages(ID_OPEN)).toBe(1);
  });

  it('removes the whole draft directory, images included (pruneOnStart)', async () => {
    const { storage, service } = setup();
    await seed(storage, makeDraft(ID_OLD, { status: 'posted', issueNumber: 7 }), 31 * DAY_MS, 3);
    expect(await fs.readdir(path.join(baseDir, ID_OLD, 'images'))).toHaveLength(3);

    await service.pruneOnStart();

    expect(await exists(ID_OLD)).toBe(false);
  });

  describe('a draft whose draft.json cannot be read is never deleted, whatever the class of the error', () => {
    async function expectSurvives(prepare: (storage: IssueDraftStoragePort) => Promise<void>, storageOptions = {}) {
      const { storage, service, warn } = setup({}, storageOptions);
      await seed(storage, makeDraft(ID_BAD), 400 * DAY_MS, 1);
      await prepare(storage);

      const result = await receiveOne(service);

      expect(result.ok && result.outcome).toBe('created');
      expect(await exists(ID_BAD)).toBe(true);
      expect(await storage.countImages(ID_BAD)).toBe(1);
      return { warn, storage };
    }

    function failReading(code: string): void {
      const realReadFile = fs.readFile.bind(fs) as unknown as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs, 'readFile').mockImplementation(((...args: unknown[]) => {
        if (!String(args[0]).includes(ID_BAD)) return realReadFile(...args);
        return Promise.reject(Object.assign(new Error('example-user private message'), { code }));
      }) as unknown as typeof fs.readFile);
    }

    const readRetry = { sleep: () => Promise.resolve() };

    it('invalid JSON (permanent)', async () => {
      await expectSurvives(async () => {
        const target = path.join(baseDir, ID_BAD, 'draft.json');
        await fs.writeFile(target, '{ not json');
        const old = new Date(NOW.getTime() - 400 * DAY_MS);
        await fs.utimes(target, old, old);
      });
    });

    it('draft.json is a directory (EISDIR, permanent)', async () => {
      await expectSurvives(async () => {
        const target = path.join(baseDir, ID_BAD, 'draft.json');
        await fs.rm(target);
        await fs.mkdir(target);
      });
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('no permission to read it (EACCES, permanent off win32)', async () => {
      const { storage } = await expectSurvives(async () => {
        await fs.chmod(path.join(baseDir, ID_BAD, 'draft.json'), 0o000);
      });
      await fs.chmod(path.join(baseDir, ID_BAD, 'draft.json'), 0o600);
      expect((await storage.get(ID_BAD))?.status).toBe('dismissed');
    });

    it.each([
      ['EBUSY', 'per-file: still busy after the retries'],
      ['EIO', 'unlisted'],
    ])('%s (%s)', async (code) => {
      await expectSurvives(() => Promise.resolve(failReading(code)), { readRetry });
    });

    // 受け取りの索引づくり (scan) はこの失敗で投げる (r50m: どの下書きも読めない状態)。掃除は、その同じ失敗を警告にして
    // 何も消さずに終わる。
    it('EMFILE (process-wide, never clears): the prune warns with the code only, deletes nothing, and does not throw', async () => {
      const { service, storage, warn } = setup({}, { readRetry });
      await seed(storage, makeDraft(ID_BAD), 400 * DAY_MS, 1);
      failReading('EMFILE');

      await expect(service.pruneOnStart()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('issue draft survey failed (EMFILE)');
      expect(await exists(ID_BAD)).toBe(true);
    });
  });

  describe('the size of the directory', () => {
    it('seeds the same complete index entries as scan, excluding directories, corrupt JSON and a file that is not a directory', async () => {
      const { storage } = setup();
      await seed(storage, makeDraft(ID_OLD), 0);
      await seed(storage, makeDraft(ID_OPEN, { status: 'pending', dismissReason: undefined }), 0);
      await fs.writeFile(path.join(baseDir, ID_UNDER), 'not a directory'); // draft.json の stat が ENOTDIR (恒久: 一覧は欠けない)
      await fs.mkdir(path.join(baseDir, ID_BAD), { recursive: true });
      await fs.writeFile(path.join(baseDir, ID_BAD, 'draft.json'), '{ broken');
      const scanned = await storage.scan();
      const survey = await storage.survey();
      expect(survey.indexSeed?.entries.map(({ id, fingerprint, firstOccurredAt, status }) => ({ id, fingerprint, firstOccurredAt, status })).sort((a, b) => a.id.localeCompare(b.id)))
        .toEqual(scanned.drafts.map(({ id, fingerprint, firstOccurredAt, status }) => ({ id, fingerprint, firstOccurredAt, status })).sort((a, b) => a.id.localeCompare(b.id)));
      expect(survey.indexSeed?.complete).toBe(scanned.complete);
      expect(scanned.complete).toBe(true);
    });

    it('reads each draft.json once from start to the first receive (the startup survey builds the index; it used to be twice)', async () => {
      const { storage, service } = setup();
      const count = 20;
      for (let index = 0; index < count; index += 1) {
        const id = `${1758812346100 + index}-c1b2c3d4e5f6a7b8`;
        await seed(storage, makeDraft(id, { status: 'pending', dismissReason: undefined }), 0);
      }
      const realReadFile = fs.readFile.bind(fs) as unknown as (...args: unknown[]) => Promise<unknown>;
      let draftJsonReads = 0;
      vi.spyOn(fs, 'readFile').mockImplementation(((...args: unknown[]) => {
        if (String(args[0]).endsWith('draft.json')) draftJsonReads += 1;
        return realReadFile(...args);
      }) as unknown as typeof fs.readFile);

      const [, first] = await Promise.all([service.pruneOnStart(), receiveOne(service, 'brand-new')]);

      expect(first.ok && first.outcome).toBe('created');
      expect(draftJsonReads).toBe(count); // 直す前は survey と scan で 2 * count
      await receiveOne(service, 'another-new');
      expect(draftJsonReads).toBe(count); // 以後の受け取りは (新規作成なので) 読み直さない
    });

    it('marks retryable read and stat failures incomplete', async () => {
      const { storage } = setup({}, { readRetry: { delaysMs: [0, 0, 0], sleep: () => Promise.resolve() } });
      await seed(storage, makeDraft(ID_BAD), 0);
      const realReadFile = fs.readFile.bind(fs) as unknown as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs, 'readFile').mockImplementation(((...args: unknown[]) => String(args[0]).includes(ID_BAD)
        ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
        : realReadFile(...args)) as unknown as typeof fs.readFile);
      const busySurvey = await storage.survey();
      expect(busySurvey.indexSeed).toMatchObject({ complete: false, entries: [] });
      expect((await storage.scan()).complete).toBe(false);

      vi.resetAllMocks();
      vi.restoreAllMocks();
      const realStat = fs.stat.bind(fs) as unknown as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs, 'stat').mockImplementation(((...args: unknown[]) => String(args[0]).endsWith(`${ID_BAD}/draft.json`)
        ? Promise.reject(Object.assign(new Error('io'), { code: 'EIO' }))
        : realStat(...args)) as unknown as typeof fs.stat);
      const statSurvey = await storage.survey();
      expect(statSurvey.indexSeed?.complete).toBe(false);
      expect(statSurvey.unmeasured).toContain('EIO');
    });

    it('is draft.json plus every file under images/, and carries the status and mtime that retention needs', async () => {
      const { storage } = setup();
      const draft = makeDraft(ID_OLD);
      await seed(storage, draft, 3 * DAY_MS, 2);
      await seed(storage, makeDraft(ID_OPEN, { status: 'pending', dismissReason: undefined }), 0);

      const survey = await storage.survey();

      const old = survey.drafts.find((item) => item.id === ID_OLD);
      expect(old).toEqual({
        id: ID_OLD,
        bytes: draftJsonBytes(draft) + 2 * PNG.byteLength,
        known: { status: 'dismissed', updatedAtMs: NOW.getTime() - 3 * DAY_MS },
      });
      expect(survey.drafts.find((item) => item.id === ID_OPEN)?.known?.status).toBe('pending');
      expect(survey.totalBytes).toBe(draftJsonBytes(draft) + 2 * PNG.byteLength + draftJsonBytes(makeDraft(ID_OPEN, { status: 'pending', dismissReason: undefined })));
      expect(survey.unmeasured).toEqual([]);
    });

    it('counts a directory without draft.json (no known status, never deleted) and ignores entries that are not draft ids', async () => {
      const { storage, service } = setup();
      await fs.mkdir(path.join(baseDir, ID_BAD, 'images'), { recursive: true });
      await fs.writeFile(path.join(baseDir, ID_BAD, 'images', '1-aaaaaaaaaaaaaaaa.png'), PNG);
      await fs.writeFile(path.join(baseDir, '.DS_Store'), 'junk');

      const survey = await storage.survey();

      expect(survey.drafts).toEqual([{ id: ID_BAD, bytes: PNG.byteLength }]);
      expect(survey.totalBytes).toBe(PNG.byteLength);

      await service.pruneOnStart();
      expect(await exists(ID_BAD)).toBe(true);
    });

    it('is empty, without an error, before anything was saved', async () => {
      const { storage, service, warn } = setup();

      expect(await storage.survey()).toEqual({ drafts: [], totalBytes: 0, unmeasured: [], indexSeed: { entries: [], complete: true } });
      await service.pruneOnStart();
      expect(warn).not.toHaveBeenCalled();
    });

    it('treats an images/ directory it cannot list as 0 bytes, reports its code, and still prunes the draft by its status', async () => {
      const { storage, service, warn } = setup();
      await seed(storage, makeDraft(ID_OLD), 40 * DAY_MS);
      await fs.writeFile(path.join(baseDir, ID_OLD, 'images'), 'not a directory'); // readdir -> ENOTDIR

      const survey = await storage.survey();
      expect(survey.drafts[0]).toMatchObject({ id: ID_OLD, bytes: draftJsonBytes(makeDraft(ID_OLD)) });
      expect(survey.unmeasured).toEqual(['ENOTDIR']);

      await service.pruneOnStart();
      expect(await exists(ID_OLD)).toBe(false);
      expect(warn).toHaveBeenCalledWith('issue draft sizes are undercounted: 1 location(s) could not be measured (ENOTDIR)');
    });

    it('treats an image it cannot stat (EIO) as 0 bytes and reports the code, but skips one that vanished (ENOENT) silently', async () => {
      const { storage } = setup();
      await seed(storage, makeDraft(ID_OLD), DAY_MS, 3);
      const names = (await fs.readdir(path.join(baseDir, ID_OLD, 'images'))).sort();
      const realStat = fs.stat.bind(fs) as unknown as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs, 'stat').mockImplementation(((...args: unknown[]) => {
        const target = String(args[0]);
        if (target.endsWith(names[0])) return Promise.reject(Object.assign(new Error('x'), { code: 'EIO' }));
        if (target.endsWith(names[1])) return Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' }));
        return realStat(...args);
      }) as unknown as typeof fs.stat);

      const survey = await storage.survey();

      expect(survey.unmeasured).toEqual(['EIO']);
      expect(survey.drafts[0].bytes).toBe(draftJsonBytes(makeDraft(ID_OLD)) + PNG.byteLength);
    });

    it('measures more drafts than one batch (64) without losing any', async () => {
      const { storage } = setup();
      const ids = Array.from({ length: 130 }, (_, index) => `${1758812346000 + index}-b1b2c3d4e5f6a7b8`);
      for (const id of ids) await storage.save(makeDraft(id, { status: 'pending', dismissReason: undefined }));

      const survey = await storage.survey();

      expect(survey.drafts.map((item) => item.id).sort()).toEqual([...ids].sort());
      expect(survey.drafts.every((item) => item.known?.status === 'pending')).toBe(true);
    });
  });

  describe('remove', () => {
    it('deletes the directory with its images, is quiet for a missing draft, and refuses an id that would escape the base dir', async () => {
      const { storage } = setup();
      await seed(storage, makeDraft(ID_OLD), DAY_MS, 2);
      await fs.writeFile(path.join(path.dirname(baseDir), 'precious.txt'), 'keep');

      await storage.remove(ID_OLD);
      await storage.remove(ID_OLD);
      await expect(storage.remove('../precious.txt')).rejects.toThrow(/invalid issue draft id/);
      await expect(storage.remove('..')).rejects.toThrow(/invalid issue draft id/);

      expect(await exists(ID_OLD)).toBe(false);
      expect(await fs.readFile(path.join(path.dirname(baseDir), 'precious.txt'), 'utf8')).toBe('keep');
    });
  });

  describe('the cap, end to end', () => {
    it('prunes the oldest terminal draft with its images to take a new report, then refuses once only open drafts are left', async () => {
      const probe = setup();
      const open = makeDraft(ID_OPEN, { status: 'pending', dismissReason: undefined });
      // 古い見送りは大きく (新しい受け取り 1 件を入れて余る)、新しい見送りは小さくしておく。
      const big = makeDraft(ID_OLD, { localOnly: { ...makeDraft(ID_OLD).localOnly, symptomRaw: 'x'.repeat(4000) } });
      await seed(probe.storage, big, 10 * DAY_MS, 2);
      await seed(probe.storage, makeDraft(ID_EXACT), 2 * DAY_MS, 0);
      await seed(probe.storage, open, 0, 0);
      const total = (await probe.storage.survey()).totalBytes;
      const { service, storage } = setup({ maxTotalBytes: total });

      const accepted = await receiveOne(service, 'a');
      expect(accepted.ok && accepted.outcome).toBe('created');
      expect(await exists(ID_OLD)).toBe(false);
      expect(await exists(ID_EXACT)).toBe(true);
      expect(await exists(ID_OPEN)).toBe(true);
      expect((await storage.survey()).totalBytes).toBeLessThanOrEqual(total);

      // 空いた分を使い切ると断る。残る見送り (小さい) を全部消しても新しい 1 件が入らないので、何も消さずに断る。
      let refused = false;
      for (let attempt = 0; attempt < 30 && !refused; attempt += 1) {
        current = new Date(current.getTime() + 2 * 60 * SECOND_MS); // 測り直しの間隔を空ける
        const result = await receiveOne(service, `slug-${attempt}`);
        if (!result.ok) {
          expect(result.reason).toBe('storage-full');
          refused = true;
        }
      }
      expect(refused).toBe(true);
      expect(await exists(ID_OPEN)).toBe(true);
      expect(await exists(ID_EXACT)).toBe(true);
      expect((await storage.survey()).totalBytes).toBeLessThanOrEqual(total);
    });

    it('refuses an image that does not fit, keeping the open draft and every file already stored', async () => {
      const probe = setup();
      await seed(probe.storage, makeDraft(ID_OPEN, { status: 'pending', dismissReason: undefined }), 0, 1);
      const total = (await probe.storage.survey()).totalBytes;
      const { service, storage } = setup({ maxTotalBytes: total });

      const result = await service.addImage(ID_OPEN, 'png', PNG);

      expect(result).toEqual({ ok: false, reason: 'storage-full' });
      expect(await storage.countImages(ID_OPEN)).toBe(1);
    });
  });

  describe('images on a dismissed draft', () => {
    it('are refused with not-pending, and nothing is written under images/', async () => {
      const { storage, service } = setup();
      await seed(storage, makeDraft(ID_UNDER), DAY_MS, 1);

      const result = await service.addImage(ID_UNDER, 'png', PNG);

      expect(result).toEqual({ ok: false, reason: 'not-pending', status: 'dismissed' });
      expect(await storage.countImages(ID_UNDER)).toBe(1);
    });
  });
});
