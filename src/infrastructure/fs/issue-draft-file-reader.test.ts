import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_READ_RETRY_DELAYS_MS,
  classifyReadError,
  createDraftFileReader,
  type DraftFileReaderOptions,
} from './issue-draft-file-reader.js';

// bdboard-r50m: draft.json の読み出しの errno の扱い。
// - プロセス全体 (EMFILE/ENFILE/EAGAIN): 再試行し、使い切ったら投げる (1 件ずつ飛ばすと一覧が空になる)。
// - ファイル単位 (EBUSY、win32 の EPERM/EACCES): 再試行し、使い切ったらその 1 件を飛ばして incomplete を付ける。
// - 恒久 (ENOTDIR/EISDIR、非 win32 の EPERM/EACCES): 再試行せず飛ばす。
// - 未列挙 (EIO など): 再試行せずその 1 件を飛ばして incomplete を付ける。
// fs.readFile を差し替え、待ちは注入した sleep で記録するだけなので実時間は待たない。

interface ReadFileSpy {
  mockRejectedValueOnce(error: unknown): ReadFileSpy;
  mockRejectedValue(error: unknown): ReadFileSpy;
  mockResolvedValue(value: unknown): ReadFileSpy;
  readonly mock: { readonly calls: readonly unknown[][] };
}

function spyReadFile(): ReadFileSpy {
  return vi.spyOn(fs, 'readFile') as unknown as ReadFileSpy;
}

function errnoError(code: string | undefined, message = 'example-user private message'): Error {
  const error = new Error(message);
  return code === undefined ? error : Object.assign(error, { code });
}

const FILE = '/example-base/1758812345678-a1b2c3d4e5f6a7b8/draft.json';
const CONTENT = '{"example":"content"}';
const PLATFORMS = ['linux', 'darwin', 'win32'] as const;

function makeReader(overrides: Partial<DraftFileReaderOptions> = {}) {
  const waits: number[] = [];
  const reader = createDraftFileReader({
    platform: 'linux',
    delaysMs: DRAFT_READ_RETRY_DELAYS_MS,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...overrides,
  });
  return { reader, waits };
}

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('DRAFT_READ_RETRY_DELAYS_MS', () => {
  it('is a short bounded backoff: 3 retries (4 reads), 140ms in total, well under a second', () => {
    expect(DRAFT_READ_RETRY_DELAYS_MS).toEqual([20, 40, 80]);
    expect(DRAFT_READ_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(500);
  });
});

describe('classifyReadError', () => {
  it.each(['EMFILE', 'ENFILE', 'EAGAIN'])('%s is process-wide on every platform', (code) => {
    for (const platform of PLATFORMS) {
      expect(classifyReadError(code, platform)).toBe('process-wide');
    }
  });

  it('EBUSY is per-file on every platform', () => {
    for (const platform of PLATFORMS) {
      expect(classifyReadError('EBUSY', platform)).toBe('per-file');
    }
  });

  it.each(['EPERM', 'EACCES'])('%s is per-file on win32 only, permanent elsewhere', (code) => {
    expect(classifyReadError(code, 'win32')).toBe('per-file');
    expect(classifyReadError(code, 'linux')).toBe('permanent');
    expect(classifyReadError(code, 'darwin')).toBe('permanent');
  });

  it.each(['ENOTDIR', 'EISDIR'])('%s is permanent on every platform (never retried)', (code) => {
    for (const platform of PLATFORMS) {
      expect(classifyReadError(code, platform)).toBe('permanent');
    }
  });

  it.each(['EIO', 'ELOOP', 'ENOMEM', 'ERR_FS_FILE_TOO_LARGE', 'ETIMEDOUT', 'enotdir', 'emfile', 'ebusy', ''])(
    '%s is unlisted',
    (code) => {
      for (const platform of ['linux', 'win32'] as const) {
        expect(classifyReadError(code, platform)).toBe('unlisted');
      }
    },
  );

  it('an error without a code is unlisted', () => {
    expect(classifyReadError(undefined, 'linux')).toBe('unlisted');
    expect(classifyReadError(undefined, 'win32')).toBe('unlisted');
  });
});

describe('createDraftFileReader', () => {
  it('reads the file with no wait when the first read succeeds', async () => {
    const readFile = spyReadFile().mockResolvedValue(CONTENT);
    const { reader, waits } = makeReader();

    expect(await reader(FILE)).toEqual({ kind: 'ok', raw: CONTENT });
    expect(readFile.mock.calls).toHaveLength(1);
    expect(readFile.mock.calls[0]).toEqual([FILE, 'utf8']);
    expect(waits).toEqual([]);
  });

  it('ENOENT is missing: no retry, no wait', async () => {
    const readFile = spyReadFile().mockRejectedValue(errnoError('ENOENT'));
    const { reader, waits } = makeReader();

    expect(await reader(FILE)).toEqual({ kind: 'missing' });
    expect(readFile.mock.calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  describe('a retryable error (process-wide or per-file) is retried with a short backoff', () => {
    it.each(['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY'])('%s once, then the read succeeds', async (code) => {
      const readFile = spyReadFile().mockRejectedValueOnce(errnoError(code)).mockResolvedValue(CONTENT);
      const { reader, waits } = makeReader();

      expect(await reader(FILE)).toEqual({ kind: 'ok', raw: CONTENT });
      expect(readFile.mock.calls).toHaveLength(2);
      expect(waits).toEqual([20]);
    });

    it('succeeding on the last (4th) read is still a success, after waiting 20, 40 and 80', async () => {
      const readFile = spyReadFile()
        .mockRejectedValueOnce(errnoError('EMFILE'))
        .mockRejectedValueOnce(errnoError('EBUSY'))
        .mockRejectedValueOnce(errnoError('EAGAIN'))
        .mockResolvedValue(CONTENT);
      const { reader, waits } = makeReader();

      expect(await reader(FILE)).toEqual({ kind: 'ok', raw: CONTENT });
      expect(readFile.mock.calls).toHaveLength(4);
      expect(waits).toEqual([20, 40, 80]);
    });

    it('a non-retryable error after a retryable one ends the retrying and is classified', async () => {
      const readFile = spyReadFile().mockRejectedValueOnce(errnoError('EMFILE')).mockRejectedValue(errnoError('EIO'));
      const { reader, waits } = makeReader();

      expect(await reader(FILE)).toEqual({ kind: 'unusable', reason: 'unreadable (EIO)', incomplete: true });
      expect(readFile.mock.calls).toHaveLength(2);
      expect(waits).toEqual([20]);
    });

    it('a missing file after a retryable error is missing', async () => {
      spyReadFile().mockRejectedValueOnce(errnoError('EBUSY')).mockRejectedValue(errnoError('ENOENT'));
      const { reader } = makeReader();

      expect(await reader(FILE)).toEqual({ kind: 'missing' });
    });
  });

  // プロセス全体の不足: どの下書きを読んでも起きる。1 件ずつ飛ばすと一覧のほとんどが空になるので、使い切ったら投げる。
  describe('a process-wide error that never clears is thrown after the retries, never skipped', () => {
    it.each(['EMFILE', 'ENFILE', 'EAGAIN'])(
      '%s forever: 4 reads, waits of 20, 40 and 80, then the original error is thrown',
      async (code) => {
        const error = errnoError(code);
        const readFile = spyReadFile().mockRejectedValue(error);
        const { reader, waits } = makeReader();

        await expect(reader(FILE)).rejects.toBe(error);
        expect(readFile.mock.calls).toHaveLength(4);
        expect(waits).toEqual([20, 40, 80]);
      },
    );

    it.each(PLATFORMS)('is the same on %s', async (platform) => {
      const error = errnoError('EMFILE');
      spyReadFile().mockRejectedValue(error);
      const { reader } = makeReader({ platform });

      await expect(reader(FILE)).rejects.toBe(error);
    });

    it('an empty backoff means no retry at all', async () => {
      const error = errnoError('EMFILE');
      const readFile = spyReadFile().mockRejectedValue(error);
      const { reader, waits } = makeReader({ delaysMs: [] });

      await expect(reader(FILE)).rejects.toBe(error);
      expect(readFile.mock.calls).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('waits exactly the injected delays, in order', async () => {
      const readFile = spyReadFile().mockRejectedValue(errnoError('EMFILE'));
      const { reader, waits } = makeReader({ delaysMs: [1, 2] });

      await expect(reader(FILE)).rejects.toThrow('private message');
      expect(readFile.mock.calls).toHaveLength(3);
      expect(waits).toEqual([1, 2]);
    });
  });

  // ファイル単位: 他のプロセス (同期クライアント・アンチウイルス) がそのファイルを握っている間だけ起きる。
  // 投げると握られた 1 件のせいで一覧も受け取りも 500 になる。使い切ったらその 1 件だけを飛ばす。
  describe('a per-file error that never clears skips that one draft after the retries', () => {
    it.each(PLATFORMS)(
      'EBUSY forever on %s: 4 reads, waits of 20, 40 and 80, then skipped as unreadable (EBUSY) and incomplete',
      async (platform) => {
        const readFile = spyReadFile().mockRejectedValue(errnoError('EBUSY'));
        const { reader, waits } = makeReader({ platform });

        const result = await reader(FILE);
        expect(result).toEqual({ kind: 'unusable', reason: 'unreadable (EBUSY)', incomplete: true });
        expect(JSON.stringify(result)).not.toContain('example-user');
        expect(readFile.mock.calls).toHaveLength(4);
        expect(waits).toEqual([20, 40, 80]);
      },
    );

    it('an empty backoff skips at once: one read, no wait', async () => {
      const readFile = spyReadFile().mockRejectedValue(errnoError('EBUSY'));
      const { reader, waits } = makeReader({ delaysMs: [] });

      expect(await reader(FILE)).toEqual({ kind: 'unusable', reason: 'unreadable (EBUSY)', incomplete: true });
      expect(readFile.mock.calls).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('waits exactly the injected delays, in order, before skipping', async () => {
      const readFile = spyReadFile().mockRejectedValue(errnoError('EBUSY'));
      const { reader, waits } = makeReader({ delaysMs: [1, 2] });

      expect(await reader(FILE)).toEqual({ kind: 'unusable', reason: 'unreadable (EBUSY)', incomplete: true });
      expect(readFile.mock.calls).toHaveLength(3);
      expect(waits).toEqual([1, 2]);
    });
  });

  // 使い切ったときは、最後に出たエラーの種類で決まる。
  describe('when the retries run out, the class of the last error decides', () => {
    it('process-wide errors followed by a last EBUSY: skipped', async () => {
      spyReadFile()
        .mockRejectedValueOnce(errnoError('EMFILE'))
        .mockRejectedValueOnce(errnoError('EAGAIN'))
        .mockRejectedValueOnce(errnoError('ENFILE'))
        .mockRejectedValue(errnoError('EBUSY'));
      const { reader } = makeReader();

      expect(await reader(FILE)).toEqual({ kind: 'unusable', reason: 'unreadable (EBUSY)', incomplete: true });
    });

    it('EBUSY followed by a last EMFILE: thrown', async () => {
      const last = errnoError('EMFILE');
      spyReadFile()
        .mockRejectedValueOnce(errnoError('EBUSY'))
        .mockRejectedValueOnce(errnoError('EBUSY'))
        .mockRejectedValueOnce(errnoError('EBUSY'))
        .mockRejectedValue(last);
      const { reader } = makeReader();

      await expect(reader(FILE)).rejects.toBe(last);
    });
  });

  describe('EPERM and EACCES are per-file errors on win32 only', () => {
    it.each(['EPERM', 'EACCES'])('win32: %s once, then the read succeeds', async (code) => {
      const readFile = spyReadFile().mockRejectedValueOnce(errnoError(code)).mockResolvedValue(CONTENT);
      const { reader, waits } = makeReader({ platform: 'win32' });

      expect(await reader(FILE)).toEqual({ kind: 'ok', raw: CONTENT });
      expect(readFile.mock.calls).toHaveLength(2);
      expect(waits).toEqual([20]);
    });

    // 本物の ACL の拒否も、アンチウイルスの一時的なロックも、ここでは見分けられない。投げると 1 件のせいで全体が 500 になり、
    // #859 までは飛ばしていたものの退行にもなる。4 回読んでも駄目ならその 1 件だけを飛ばし、索引はキャッシュさせない。
    it.each(['EPERM', 'EACCES'])(
      'win32: %s forever is skipped after 4 reads as unreadable and incomplete, not thrown',
      async (code) => {
        const readFile = spyReadFile().mockRejectedValue(errnoError(code));
        const { reader, waits } = makeReader({ platform: 'win32' });

        const result = await reader(FILE);
        expect(result).toEqual({ kind: 'unusable', reason: `unreadable (${code})`, incomplete: true });
        expect(JSON.stringify(result)).not.toContain('example-user');
        expect(readFile.mock.calls).toHaveLength(4);
        expect(waits).toEqual([20, 40, 80]);
      },
    );

    it.each([
      ['EPERM', 'linux'],
      ['EACCES', 'linux'],
      ['EPERM', 'darwin'],
      ['EACCES', 'darwin'],
    ] as const)('%s on %s is a permanent skip: one read, no wait, the listing stays complete', async (code, platform) => {
      const readFile = spyReadFile().mockRejectedValue(errnoError(code));
      const { reader, waits } = makeReader({ platform });

      expect(await reader(FILE)).toEqual({ kind: 'unusable', reason: `unreadable (${code})`, incomplete: false });
      expect(readFile.mock.calls).toHaveLength(1);
      expect(waits).toEqual([]);
    });
  });

  describe('ENOTDIR and EISDIR are permanent skips on every platform', () => {
    it.each([
      ['ENOTDIR', 'linux'],
      ['EISDIR', 'linux'],
      ['ENOTDIR', 'win32'],
      ['EISDIR', 'win32'],
    ] as const)('%s on %s: one read, no wait, the listing stays complete', async (code, platform) => {
      const readFile = spyReadFile().mockRejectedValue(errnoError(code));
      const { reader, waits } = makeReader({ platform });

      expect(await reader(FILE)).toEqual({ kind: 'unusable', reason: `unreadable (${code})`, incomplete: false });
      expect(readFile.mock.calls).toHaveLength(1);
      expect(waits).toEqual([]);
    });
  });

  describe('an unlisted error skips that one draft and marks the listing incomplete', () => {
    it.each(['EIO', 'ELOOP', 'ENOMEM', 'ERR_FS_FILE_TOO_LARGE'])(
      '%s: one read, no wait, reason has the code and not the message',
      async (code) => {
        const readFile = spyReadFile().mockRejectedValue(errnoError(code));
        const { reader, waits } = makeReader();

        const result = await reader(FILE);
        expect(result).toEqual({ kind: 'unusable', reason: `unreadable (${code})`, incomplete: true });
        expect(JSON.stringify(result)).not.toContain('example-user');
        expect(readFile.mock.calls).toHaveLength(1);
        expect(waits).toEqual([]);
      },
    );

    it('an error without a code is "unknown"', async () => {
      spyReadFile().mockRejectedValue(errnoError(undefined, 'boom example-user'));
      const { reader } = makeReader();

      const result = await reader(FILE);
      expect(result).toEqual({ kind: 'unusable', reason: 'unreadable (unknown)', incomplete: true });
      expect(JSON.stringify(result)).not.toContain('boom');
    });

    it('is the same on win32', async () => {
      spyReadFile().mockRejectedValue(errnoError('EIO'));
      const { reader } = makeReader({ platform: 'win32' });

      expect(await reader(FILE)).toEqual({ kind: 'unusable', reason: 'unreadable (EIO)', incomplete: true });
    });
  });
});
