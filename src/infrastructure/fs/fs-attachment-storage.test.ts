import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsAttachmentStorage } from './fs-attachment-storage.js';

describe('createFsAttachmentStorage', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-attachments-'));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('saves, lists, counts, and reads back a file', async () => {
    const storage = createFsAttachmentStorage(baseDir);
    const data = new Uint8Array([1, 2, 3, 4]);

    expect(await storage.count('proj-abc12345', 'bdboard-qw26')).toBe(0);

    const stored = await storage.save('proj-abc12345', 'bdboard-qw26', 'png', data);
    expect(stored.fileName).toMatch(/^\d+-[0-9a-f]{16}\.png$/);
    expect(stored.byteLength).toBe(4);

    expect(await storage.count('proj-abc12345', 'bdboard-qw26')).toBe(1);

    const list = await storage.list('proj-abc12345', 'bdboard-qw26');
    expect(list).toHaveLength(1);
    expect(list[0]?.fileName).toBe(stored.fileName);

    const read = await storage.read('proj-abc12345', 'bdboard-qw26', stored.fileName);
    expect(read).toEqual(Buffer.from(data));
  });

  it('returns undefined for a missing file and an empty list/zero count for an unknown issue', async () => {
    const storage = createFsAttachmentStorage(baseDir);
    expect(await storage.read('proj-abc12345', 'bdboard-qw26', '1-aaaaaaaaaaaaaaaa.png')).toBeUndefined();
    expect(await storage.list('proj-abc12345', 'bdboard-qw26')).toEqual([]);
    expect(await storage.count('proj-abc12345', 'bdboard-qw26')).toBe(0);
  });

  it('keeps different projects and different issues isolated from each other', async () => {
    const storage = createFsAttachmentStorage(baseDir);
    await storage.save('proj-a', 'issue-1', 'png', new Uint8Array([1]));
    await storage.save('proj-a', 'issue-2', 'png', new Uint8Array([2]));
    await storage.save('proj-b', 'issue-1', 'png', new Uint8Array([3]));

    expect(await storage.count('proj-a', 'issue-1')).toBe(1);
    expect(await storage.count('proj-a', 'issue-2')).toBe(1);
    expect(await storage.count('proj-b', 'issue-1')).toBe(1);
  });

  it('rejects a path-traversal file name at read time instead of escaping the base dir', async () => {
    const storage = createFsAttachmentStorage(baseDir);
    await expect(
      storage.read('proj-a', 'issue-1', '../../../etc/passwd'),
    ).rejects.toThrow(/escapes/);
  });

  it('rejects a path-traversal project key or issue id at save time', async () => {
    const storage = createFsAttachmentStorage(baseDir);
    await expect(
      storage.save('../escape', 'issue-1', 'png', new Uint8Array([1])),
    ).rejects.toThrow(/escapes/);
    await expect(
      storage.save('proj-a', '../../escape', 'png', new Uint8Array([1])),
    ).rejects.toThrow(/escapes/);
  });
});
