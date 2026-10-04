import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IssueDraft } from '../../domain/issue-draft.js';
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
