import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_READ_RETRY_DELAYS_MS,
  classifyReadError,
  createDraftFileReader,
  type DraftFileReaderOptions,
} from './issue-draft-file-reader.js';

// bdboard-r50m: draft.json の読み出しの errno の扱い (一時的 = 再試行して使い切れば投げる / 恒久 = 飛ばす /
// 未列挙 = その 1 件を飛ばして「一覧が欠けた」印を付ける)。fs.readFile を差し替え、待ちは注入した sleep で
// 記録するだけなので実時間は待たない。

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
  it.each(['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN'])('%s is transient on every platform', (code) => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(classifyReadError(code, platform)).toBe('transient');
    }
  });

  it.each(['EPERM', 'EACCES'])('%s is transient on win32 only, permanent elsewhere', (code) => {
    expect(classifyReadError(code, 'win32')).toBe('transient');
    expect(classifyReadError(code, 'linux')).toBe('permanent');
    expect(classifyReadError(code, 'darwin')).toBe('permanent');
  });

  it.each(['ENOTDIR', 'EISDIR'])('%s is permanent on every platform (never retried)', (code) => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(classifyReadError(code, platform)).toBe('permanent');
    }
  });

  it.each(['EIO', 'ELOOP', 'ENOMEM', 'ERR_FS_FILE_TOO_LARGE', 'ETIMEDOUT', 'enotdir', 'emfile', ''])(
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

  describe('a transient error is retried with a short backoff', () => {
    it.each(['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN'])('%s once, then the read succeeds', async (code) => {
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

    it.each(['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN'])(
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

    it('an empty backoff means no retry at all', async () => {
      const error = errnoError('EMFILE');
      const readFile = spyReadFile().mockRejectedValue(error);
      const { reader, waits } = makeReader({ delaysMs: [] });

      await expect(reader(FILE)).rejects.toBe(error);
      expect(readFile.mock.calls).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('waits exactly the injected delays, in order', async () => {
      const readFile = spyReadFile().mockRejectedValue(errnoError('EBUSY'));
      const { reader, waits } = makeReader({ delaysMs: [1, 2] });

      await expect(reader(FILE)).rejects.toThrow('private message');
      expect(readFile.mock.calls).toHaveLength(3);
      expect(waits).toEqual([1, 2]);
    });

    it('a non-transient error after a transient one ends the retrying and is classified', async () => {
      const readFile = spyReadFile().mockRejectedValueOnce(errnoError('EMFILE')).mockRejectedValue(errnoError('EIO'));
      const { reader, waits } = makeReader();

      expect(await reader(FILE)).toEqual({ kind: 'unusable', reason: 'unreadable (EIO)', incomplete: true });
      expect(readFile.mock.calls).toHaveLength(2);
      expect(waits).toEqual([20]);
    });

    it('a missing file after a transient error is missing', async () => {
      spyReadFile().mockRejectedValueOnce(errnoError('EBUSY')).mockRejectedValue(errnoError('ENOENT'));
      const { reader } = makeReader();

      expect(await reader(FILE)).toEqual({ kind: 'missing' });
    });
  });

  describe('EPERM and EACCES are transient on win32 only', () => {
    it.each(['EPERM', 'EACCES'])('win32: %s once, then the read succeeds', async (code) => {
      const readFile = spyReadFile().mockRejectedValueOnce(errnoError(code)).mockResolvedValue(CONTENT);
      const { reader, waits } = makeReader({ platform: 'win32' });

      expect(await reader(FILE)).toEqual({ kind: 'ok', raw: CONTENT });
      expect(readFile.mock.calls).toHaveLength(2);
      expect(waits).toEqual([20]);
    });

    it.each(['EPERM', 'EACCES'])('win32: %s forever is thrown after 4 reads, never skipped', async (code) => {
      const error = errnoError(code);
      const readFile = spyReadFile().mockRejectedValue(error);
      const { reader, waits } = makeReader({ platform: 'win32' });

      await expect(reader(FILE)).rejects.toBe(error);
      expect(readFile.mock.calls).toHaveLength(4);
      expect(waits).toEqual([20, 40, 80]);
    });

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
