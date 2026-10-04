import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import { ISSUE_DRAFT_MAX_JSON_BYTES, type IssueDraft } from '../../domain/issue-draft.js';
import { createFsIssueDraftStorage } from './fs-issue-draft-storage.js';

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
      errorTextRaw: 'raw log with example-user data',
      errorTextHead: 'raw log with example-user data',
      errorTextTail: '',
      errorTextTruncated: false,
      envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' },
    },
    occurredProjects: [
      { name: 'example-project', path: '/p/example', firstSeenAt: '2026-10-04T12:00:00.000Z', lastSeenAt: '2026-10-04T12:00:00.000Z' },
    ],
    occurrenceCount: 1,
    firstOccurredAt: '2026-10-04T12:00:00.000Z',
    lastOccurredAt: '2026-10-04T12:00:00.000Z',
    status: 'pending',
    draftSchemaVersion: 1,
    ...overrides,
  };
}

const ID_1 = '1758812345678-a1b2c3d4e5f6a7b8';
const ID_2 = '1758812345679-b1b2c3d4e5f6a7b8';

describe('createFsIssueDraftStorage', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-issue-drafts-')), 'issue-drafts');
  });

  afterEach(async () => {
    await fs.rm(path.dirname(baseDir), { recursive: true, force: true });
  });

  it('saves a draft as <id>/draft.json and reads it back', async () => {
    const storage = createFsIssueDraftStorage(baseDir);
    const draft = makeDraft(ID_1);
    await storage.save(draft);

    expect(await storage.get(ID_1)).toEqual(draft);
    const onDisk = JSON.parse(await fs.readFile(path.join(baseDir, ID_1, 'draft.json'), 'utf8'));
    expect(onDisk.id).toBe(ID_1);
  });

  it('overwrites on a second save and leaves no temp file behind', async () => {
    const storage = createFsIssueDraftStorage(baseDir);
    await storage.save(makeDraft(ID_1));
    await storage.save(makeDraft(ID_1, { occurrenceCount: 5 }));

    expect((await storage.get(ID_1))?.occurrenceCount).toBe(5);
    expect(await fs.readdir(path.join(baseDir, ID_1))).toEqual(['draft.json']);
  });

  it('writes private files: directories 0700 and draft.json 0600 (the raw error text is local-only)', async () => {
    const storage = createFsIssueDraftStorage(baseDir);
    await storage.save(makeDraft(ID_1));
    await storage.saveImage(ID_1, 'png', new Uint8Array([1, 2, 3]));

    const mode = async (target: string) => (await fs.stat(target)).mode & 0o777;
    expect(await mode(baseDir)).toBe(0o700);
    expect(await mode(path.join(baseDir, ID_1))).toBe(0o700);
    expect(await mode(path.join(baseDir, ID_1, 'draft.json'))).toBe(0o600);
    expect(await mode(path.join(baseDir, ID_1, 'images'))).toBe(0o700);
    const [imageName] = await fs.readdir(path.join(baseDir, ID_1, 'images'));
    expect(await mode(path.join(baseDir, ID_1, 'images', imageName))).toBe(0o600);
  });

  it('lists every draft and skips a corrupt draft.json instead of failing the whole list', async () => {
    const storage = createFsIssueDraftStorage(baseDir);
    await storage.save(makeDraft(ID_1));
    await storage.save(makeDraft(ID_2));
    await fs.mkdir(path.join(baseDir, '1758812345680-c1b2c3d4e5f6a7b8'), { recursive: true });
    await fs.writeFile(path.join(baseDir, '1758812345680-c1b2c3d4e5f6a7b8', 'draft.json'), '{ not json');
    await fs.mkdir(path.join(baseDir, 'stray-dir'), { recursive: true });

    const ids = (await storage.list()).map((draft) => draft.id).sort();
    expect(ids).toEqual([ID_1, ID_2]);
  });

  describe('an unreadable or broken draft is skipped with a warning, never thrown', () => {
    const BROKEN_ID = '1758812345680-c1b2c3d4e5f6a7b8';

    it.each([
      ['a draft id that is a plain file (ENOTDIR)', async () => fs.writeFile(path.join(baseDir, BROKEN_ID), 'not a directory'), 'ENOTDIR'],
      [
        'a draft.json that is a directory (EISDIR)',
        async () => fs.mkdir(path.join(baseDir, BROKEN_ID, 'draft.json'), { recursive: true }),
        'EISDIR',
      ],
      [
        'a draft.json that is not JSON',
        async () => {
          await fs.mkdir(path.join(baseDir, BROKEN_ID), { recursive: true });
          await fs.writeFile(path.join(baseDir, BROKEN_ID, 'draft.json'), '{ not json SECRET-CONTENT');
        },
        'not valid JSON',
      ],
      [
        'a draft.json of the wrong shape',
        async () => {
          await fs.mkdir(path.join(baseDir, BROKEN_ID), { recursive: true });
          await fs.writeFile(path.join(baseDir, BROKEN_ID, 'draft.json'), JSON.stringify({ id: BROKEN_ID, kind: 'Z' }));
        },
        'does not match the draft format',
      ],
      [
        'a draft.json whose id is another draft',
        async () => {
          await fs.mkdir(path.join(baseDir, BROKEN_ID), { recursive: true });
          await fs.writeFile(path.join(baseDir, BROKEN_ID, 'draft.json'), JSON.stringify(makeDraft(ID_1)));
        },
        'id does not match its directory',
      ],
    ])('%s', async (_label, breakIt, reason) => {
      const warn = vi.fn();
      const storage = createFsIssueDraftStorage(baseDir, { warn });
      await storage.save(makeDraft(ID_1));
      await breakIt();

      expect((await storage.list()).map((draft) => draft.id)).toEqual([ID_1]);
      expect(await storage.get(BROKEN_ID)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain(BROKEN_ID);
      expect(message).toContain(reason);
      // 警告に下書きの中身は出さない。
      expect(message).not.toContain('SECRET-CONTENT');
      // 同じ下書きの同じ理由は繰り返し警告しない (一覧は何度も呼ばれる)。
      await storage.list();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'a draft directory without permission (EACCES)',
      async () => {
        const warn = vi.fn();
        const storage = createFsIssueDraftStorage(baseDir, { warn });
        await storage.save(makeDraft(ID_1));
        await storage.save(makeDraft(ID_2));
        await fs.chmod(path.join(baseDir, ID_2), 0o000);
        try {
          expect((await storage.list()).map((draft) => draft.id)).toEqual([ID_1]);
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
        } finally {
          await fs.chmod(path.join(baseDir, ID_2), 0o700);
        }
      },
    );

    it('the service still starts up and receives when a draft on disk is broken', async () => {
      const warn = vi.fn();
      const storage = createFsIssueDraftStorage(baseDir, { warn });
      await storage.save(makeDraft(ID_1, { fingerprint: 'A:known' }));
      await fs.writeFile(path.join(baseDir, BROKEN_ID), 'not a directory');

      const service = createIssueDraftService({
        storage,
        now: () => new Date('2026-10-04T12:00:00.000Z'),
        newId: () => '1758812345999-d1b2c3d4e5f6a7b8',
      });
      // 索引の読み込み (最初の受け取り) も、壊れた 1 件で落ちない。既知の指紋はマージされる。
      const merged = await service.receive({ kind: 'A', catalogSlug: 'known' });
      expect(merged).toMatchObject({ ok: true, outcome: 'merged' });
      const created = await service.receive({ kind: 'A', catalogSlug: 'new-one' });
      expect(created).toMatchObject({ ok: true, outcome: 'created' });
      expect((await service.list()).map((draft) => draft.id).sort()).toEqual([ID_1, '1758812345999-d1b2c3d4e5f6a7b8']);
    });
  });

  it('writes draft.json as exactly what the 200KB cap measures, and a hostile receive stays under it on disk', async () => {
    const storage = createFsIssueDraftStorage(baseDir);
    const service = createIssueDraftService({
      storage,
      now: () => new Date('2026-10-04T12:00:00.000Z'),
      newId: () => ID_1,
    });
    const nasty = '"\\\u0001あ';
    for (let index = 0; index < 100; index += 1) {
      await service.receive({
        kind: 'B',
        source: 'hostile.sh',
        errorText: 'same error',
        symptom: nasty.repeat(2000),
        project: { name: `${index}-${nasty.repeat(49)}`, path: `/${index}/${nasty.repeat(249)}` },
      });
    }
    const file = path.join(baseDir, ID_1, 'draft.json');
    const onDisk = await fs.readFile(file, 'utf8');
    expect((await fs.stat(file)).size).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
    // 整形せず 1 行で書く (判定に使う文字列と同じ)。
    expect(onDisk.trimEnd()).not.toContain('\n');
    expect(JSON.parse(onDisk).occurrenceCount).toBe(100);
  });

  it('does not count stray non-image files (.DS_Store, notes) in images/ as images', async () => {
    const storage = createFsIssueDraftStorage(baseDir);
    await storage.save(makeDraft(ID_1));
    const stored = await storage.saveImage(ID_1, 'png', new Uint8Array([1, 2, 3]));
    const imagesDir = path.join(baseDir, ID_1, 'images');
    await fs.writeFile(path.join(imagesDir, '.DS_Store'), 'junk');
    await fs.writeFile(path.join(imagesDir, 'notes.txt'), 'junk');
    await fs.writeFile(path.join(imagesDir, '1758812345678-nothex.png'), 'junk');
    await fs.mkdir(path.join(imagesDir, '1758812345678-a1b2c3d4e5f6a7b8.png.d'));

    expect(await storage.countImages(ID_1)).toBe(1);
    expect((await storage.listImages(ID_1)).map((image) => image.fileName)).toEqual([stored.fileName]);
  });

  it('returns an empty list before anything was saved, and undefined for an unknown or invalid draft', async () => {
    const storage = createFsIssueDraftStorage(baseDir);
    expect(await storage.list()).toEqual([]);
    expect(await storage.get(ID_1)).toBeUndefined();
    await fs.mkdir(path.join(baseDir, ID_1), { recursive: true });
    await fs.writeFile(path.join(baseDir, ID_1, 'draft.json'), JSON.stringify({ id: ID_1, kind: 'Z' }));
    expect(await storage.get(ID_1)).toBeUndefined();
  });

  it('saves, counts, lists and reads images under images/', async () => {
    const storage = createFsIssueDraftStorage(baseDir);
    await storage.save(makeDraft(ID_1));
    expect(await storage.countImages(ID_1)).toBe(0);
    expect(await storage.listImages(ID_1)).toEqual([]);

    const data = new Uint8Array([9, 8, 7, 6]);
    const stored = await storage.saveImage(ID_1, 'png', data);
    expect(stored.fileName).toMatch(/^\d+-[0-9a-f]{16}\.png$/);
    expect(stored.byteLength).toBe(4);
    expect(await storage.countImages(ID_1)).toBe(1);
    expect((await storage.listImages(ID_1)).map((image) => image.fileName)).toEqual([stored.fileName]);
    expect(await storage.readImage(ID_1, stored.fileName)).toEqual(Buffer.from(data));
    expect(await storage.readImage(ID_1, '1-aaaaaaaaaaaaaaaa.png')).toBeUndefined();
  });

  it('refuses ids and file names that would escape the base dir', async () => {
    const storage = createFsIssueDraftStorage(baseDir);
    await expect(storage.get('../outside')).rejects.toThrow(/invalid issue draft id/);
    await expect(storage.save(makeDraft('../outside'))).rejects.toThrow(/invalid issue draft id/);
    await expect(storage.saveImage('../outside', 'png', new Uint8Array([1]))).rejects.toThrow(/invalid issue draft id/);
    await expect(storage.readImage(ID_1, '../../draft.json')).rejects.toThrow(/escapes/);
  });
});
