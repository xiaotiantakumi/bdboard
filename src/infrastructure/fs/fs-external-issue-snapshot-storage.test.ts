import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSnapshotRecord,
  prepareExternalIssue,
  type StoredExternalIssueSnapshot,
} from '../../domain/external-issue-snapshot-record.js';
import { createFsExternalIssueSnapshotStorage } from './fs-external-issue-snapshot-storage.js';

// 見えない文字はソースに直接書かず、実行時に組む (Trojan Source の検査に当たる)。
const ZWSP = String.fromCodePoint(0x200b);

function makeSnapshot(number: number, overrides: Partial<StoredExternalIssueSnapshot> = {}): StoredExternalIssueSnapshot {
  const prepared = prepareExternalIssue({
    number,
    title: `crash ${number}${ZWSP}`,
    body: 'steps <!-- hidden --> https://example.com/x',
    updatedAt: '2026-10-05T00:00:00Z',
  });
  return { ...createSnapshotRecord(prepared, '2026-10-06T00:00:00.000Z'), ...overrides };
}

const SECRET_BODY_TEXT = 'example-private-body-text';

describe('createFsExternalIssueSnapshotStorage', () => {
  let root: string;
  let baseDir: string;
  let warn: ReturnType<typeof vi.fn<(message: string) => void>>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-external-issues-'));
    baseDir = path.join(root, 'external-issues');
    warn = vi.fn<(message: string) => void>();
  });

  afterEach(async () => {
    // 権限のテストで 000 にしたファイルがあっても消せるよう、ディレクトリごと force で消す。
    await fs.rm(root, { recursive: true, force: true });
  });

  const make = () => createFsExternalIssueSnapshotStorage(baseDir, { warn });

  describe('save / get / list', () => {
    it('round-trips a snapshot, including the machine checks', async () => {
      const storage = make();
      const snapshot = makeSnapshot(12);
      await storage.save(snapshot);
      expect(await storage.get(12)).toEqual(snapshot);
      expect(snapshot.checks.title.invisibleChars.total).toBe(1);
      expect(snapshot.checks.body.htmlComments.count).toBe(1);
    });

    it('writes <baseDir>/<number>.json', async () => {
      await make().save(makeSnapshot(12));
      expect(await fs.readdir(baseDir)).toEqual(['12.json']);
    });

    it('lists every readable snapshot, in ascending number order', async () => {
      const storage = make();
      await storage.save(makeSnapshot(30));
      await storage.save(makeSnapshot(4));
      await storage.save(makeSnapshot(1_000));
      expect((await storage.scan()).snapshots.map((snapshot) => snapshot.number)).toEqual([4, 30, 1_000]);
    });

    it('returns an empty list and undefined when nothing has been saved yet (no directory)', async () => {
      const storage = make();
      expect((await storage.scan()).snapshots).toEqual([]);
      expect(await storage.get(5)).toBeUndefined();
    });

    it('overwrites an existing snapshot', async () => {
      const storage = make();
      await storage.save(makeSnapshot(12));
      await storage.save(makeSnapshot(12, { needsRejudge: true, missingSince: '2026-10-07T00:00:00.000Z' }));
      expect(await storage.get(12)).toMatchObject({ needsRejudge: true, missingSince: '2026-10-07T00:00:00.000Z' });
      expect((await storage.scan()).snapshots).toHaveLength(1);
    });

    it('keeps only the snapshot fields: an extra field on the object (url, author) is not written', async () => {
      const bigger = { ...makeSnapshot(12), url: 'https://github.com/o/r/issues/12', author: 'someone' };
      await make().save(bigger);
      const written = JSON.parse(await fs.readFile(path.join(baseDir, '12.json'), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(written)).not.toContain('url');
      expect(Object.keys(written)).not.toContain('author');
      expect(Object.keys(written).sort()).toEqual(Object.keys(makeSnapshot(12)).sort());
    });

    it('refuses to write a record that is not in the snapshot format, and writes nothing', async () => {
      const storage = make();
      await expect(storage.save(makeSnapshot(12, { snapshotAt: 'not-a-date' }))).rejects.toThrow();
      await expect(fs.readdir(baseDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('permissions (POSIX only: Windows ignores the mode bits)', () => {
    it.skipIf(process.platform === 'win32')('creates the directory 0700 and the file 0600', async () => {
      await make().save(makeSnapshot(12));
      const mode = async (target: string) => (await fs.stat(target)).mode & 0o777;
      expect(await mode(baseDir)).toBe(0o700);
      expect(await mode(path.join(baseDir, '12.json'))).toBe(0o600);
    });

    it.skipIf(process.platform === 'win32')('keeps the file 0600 when it overwrites one', async () => {
      const storage = make();
      await storage.save(makeSnapshot(12));
      await storage.save(makeSnapshot(12, { needsRejudge: true }));
      expect((await fs.stat(path.join(baseDir, '12.json'))).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === 'win32')('creates a missing parent directory 0700 too', async () => {
      const nested = path.join(root, 'data', 'external-issues');
      await createFsExternalIssueSnapshotStorage(nested, { warn }).save(makeSnapshot(12));
      expect((await fs.stat(path.join(root, 'data'))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(nested)).mode & 0o777).toBe(0o700);
    });
  });

  describe('atomic write', () => {
    it('leaves no temporary file behind after a save', async () => {
      const storage = make();
      await storage.save(makeSnapshot(12));
      await storage.save(makeSnapshot(13));
      expect((await fs.readdir(baseDir)).sort()).toEqual(['12.json', '13.json']);
    });

    it('writes to a temporary file in the same directory, then renames it over the snapshot', async () => {
      const storage = make();
      await storage.save(makeSnapshot(12));
      const original = await fs.readFile(path.join(baseDir, '12.json'), 'utf8');
      const rename = vi.spyOn(fs, 'rename');
      try {
        await storage.save(makeSnapshot(12, { needsRejudge: true }));
        expect(rename).toHaveBeenCalledTimes(1);
        const [from, to] = rename.mock.calls[0] as [string, string];
        expect(path.dirname(from)).toBe(baseDir);
        expect(path.basename(from)).toMatch(/^12\.json\.[0-9a-f]+\.tmp$/);
        expect(to).toBe(path.join(baseDir, '12.json'));
      } finally {
        rename.mockRestore();
      }
      expect(await fs.readFile(path.join(baseDir, '12.json'), 'utf8')).not.toBe(original);
    });

    it('keeps the old snapshot and removes the temporary file when the rename fails', async () => {
      const storage = make();
      await storage.save(makeSnapshot(12));
      const before = await fs.readFile(path.join(baseDir, '12.json'), 'utf8');
      const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      try {
        await expect(storage.save(makeSnapshot(12, { needsRejudge: true }))).rejects.toMatchObject({ code: 'ENOSPC' });
      } finally {
        rename.mockRestore();
      }
      expect(await fs.readFile(path.join(baseDir, '12.json'), 'utf8')).toBe(before);
      expect(await fs.readdir(baseDir)).toEqual(['12.json']);
    });

    it('reports the original error even when removing the temporary file fails too', async () => {
      const storage = make();
      const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EIO' }));
      const rm = vi.spyOn(fs, 'rm').mockRejectedValueOnce(Object.assign(new Error('also boom'), { code: 'EPERM' }));
      try {
        await expect(storage.save(makeSnapshot(12))).rejects.toMatchObject({ code: 'EIO' });
      } finally {
        rename.mockRestore();
        rm.mockRestore();
      }
    });
  });

  describe('the number is the only thing that picks a path', () => {
    it.each([0, -1, 1.5, 10_000_000_000, Number.NaN, 1e21])('rejects %s on every method and writes nothing', async (value) => {
      const storage = make();
      await expect(storage.get(value)).rejects.toThrow(/invalid external issue number/);
      await expect(storage.remove(value)).rejects.toThrow(/invalid external issue number/);
      await expect(storage.save(makeSnapshot(12, { number: value }))).rejects.toThrow(/invalid external issue number/);
      await expect(fs.readdir(baseDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('accepts the largest allowed number (10 digits)', async () => {
      const storage = make();
      await storage.save(makeSnapshot(9_999_999_999));
      expect(await fs.readdir(baseDir)).toEqual(['9999999999.json']);
      expect(await storage.get(9_999_999_999)).toMatchObject({ number: 9_999_999_999 });
    });

    it('does not read files whose names are not <number>.json (leading zero, 11 digits, temp files, strays)', async () => {
      const storage = make();
      await storage.save(makeSnapshot(12));
      const valid = await fs.readFile(path.join(baseDir, '12.json'), 'utf8');
      for (const name of ['012.json', '12345678901.json', '12.json.abcdef.tmp', '12.json.bak', 'notes.txt', '.DS_Store', '12.JSON']) {
        await fs.writeFile(path.join(baseDir, name), valid);
      }
      expect((await storage.scan()).snapshots.map((snapshot) => snapshot.number)).toEqual([12]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('files that cannot be used', () => {
    // bdboard-g2ti: サービスが「初めて見た issue」(ファイルが無い) と区別できるよう、使えない写しの番号を返す。
    it('scan gives the numbers of the files that cannot be used (not JSON, wrong format, wrong number, a directory), in ascending order, and leaves them out', async () => {
      const storage = make();
      await storage.save(makeSnapshot(12));
      await fs.writeFile(path.join(baseDir, '16.json'), JSON.stringify({ ...makeSnapshot(16), checks: 'nope' }));
      await fs.writeFile(path.join(baseDir, '13.json'), 'not json {');
      await fs.writeFile(path.join(baseDir, '14.json'), JSON.stringify(makeSnapshot(13)));
      await fs.mkdir(path.join(baseDir, '15.json'));
      // 番号の形のファイル名ではないものは、使えない写しにも数えない (読まないファイル)。
      await fs.writeFile(path.join(baseDir, 'notes.json'), 'not json {');
      await fs.writeFile(path.join(baseDir, '17.json.abcdef123456.tmp'), 'half written');

      const result = await storage.scan();
      expect(result.unusable).toEqual([13, 14, 15, 16]);
      expect(result.snapshots.map((snapshot) => snapshot.number)).toEqual([12]);
      expect(result.snapshots.every((snapshot) => !result.unusable.includes(snapshot.number))).toBe(true);
      expect([...result.snapshots.map((snapshot) => snapshot.number), ...result.unusable].sort((a, b) => a - b)).toEqual([12, 13, 14, 15, 16]);
    });

    it('scan does not include a number that has no file, and is empty when the base directory does not exist', async () => {
      const storage = make();
      expect((await storage.scan()).unusable).toEqual([]);
      await storage.save(makeSnapshot(12));
      expect((await storage.scan()).unusable).toEqual([]);
    });

    it('scan warns once for the same broken file across repeated scans', async () => {
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(path.join(baseDir, '13.json'), `{ not json ${SECRET_BODY_TEXT}`);
      const storage = make();

      await storage.scan();
      await storage.scan();
      await storage.scan();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('external issue snapshot 13 is skipped: not valid JSON');
    });

    it('scan: a number drops out of unusable once the file is written again', async () => {
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(path.join(baseDir, '13.json'), 'garbage');
      const storage = make();
      expect((await storage.scan()).unusable).toEqual([13]);

      await storage.save(makeSnapshot(13));

      expect((await storage.scan()).unusable).toEqual([]);
    });

    it('skips a file that is not JSON, with one warning that names the number and the reason but not the content', async () => {
      const storage = make();
      await storage.save(makeSnapshot(12));
      await fs.writeFile(path.join(baseDir, '13.json'), `{ not json ${SECRET_BODY_TEXT}`);
      expect((await storage.scan()).snapshots.map((snapshot) => snapshot.number)).toEqual([12]);
      expect(await storage.get(13)).toBeUndefined();
      await storage.scan();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe('external issue snapshot 13 is skipped: not valid JSON');
      expect(warn.mock.calls[0]?.[0]).not.toContain(SECRET_BODY_TEXT);
    });

    it('skips a file whose JSON does not match the snapshot format', async () => {
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(path.join(baseDir, '13.json'), JSON.stringify({ ...makeSnapshot(13), checks: 'nope' }));
      const storage = make();
      expect((await storage.scan()).snapshots).toEqual([]);
      expect(warn).toHaveBeenCalledWith('external issue snapshot 13 is skipped: does not match the snapshot format');
    });

    it('skips a file whose number does not match its file name (a copy renamed by hand)', async () => {
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(path.join(baseDir, '14.json'), JSON.stringify(makeSnapshot(13)));
      const storage = make();
      expect(await storage.get(14)).toBeUndefined();
      expect(warn).toHaveBeenCalledWith('external issue snapshot 14 is skipped: number does not match its file name');
    });

    it('skips a directory that sits where a snapshot should be', async () => {
      await fs.mkdir(path.join(baseDir, '15.json'), { recursive: true });
      const storage = make();
      expect((await storage.scan()).snapshots).toEqual([]);
      expect(warn).toHaveBeenCalledWith('external issue snapshot 15 is skipped: is a directory');
    });

    it('lets a skipped number be written again (the next save replaces the broken file)', async () => {
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(path.join(baseDir, '13.json'), 'garbage');
      const storage = make();
      await storage.save(makeSnapshot(13));
      expect(await storage.get(13)).toEqual(makeSnapshot(13));
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'throws for a read failure that is not "no such file" (here: no permission), instead of treating the snapshot as absent',
      async () => {
        const storage = make();
        await storage.save(makeSnapshot(12));
        await fs.chmod(path.join(baseDir, '12.json'), 0o000);
        await expect(storage.scan()).rejects.toMatchObject({ code: 'EACCES' });
        await expect(storage.get(12)).rejects.toMatchObject({ code: 'EACCES' });
      },
    );
  });

  describe('remove', () => {
    it('deletes the snapshot', async () => {
      const storage = make();
      await storage.save(makeSnapshot(12));
      await storage.save(makeSnapshot(13));
      await storage.remove(12);
      expect(await fs.readdir(baseDir)).toEqual(['13.json']);
    });

    it('does nothing for a snapshot that is not there (and when the directory does not exist)', async () => {
      const storage = make();
      await expect(storage.remove(12)).resolves.toBeUndefined();
      await storage.save(makeSnapshot(13));
      await expect(storage.remove(12)).resolves.toBeUndefined();
      expect(await fs.readdir(baseDir)).toEqual(['13.json']);
    });
  });
});
