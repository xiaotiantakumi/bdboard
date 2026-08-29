import { describe, expect, it } from 'vitest';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import { createCwdResolver } from './resolve-transcript-path.js';

function createFakeFs(
  realPathImpl: (dirPath: string) => Promise<string>,
): FileSystemPort & { realPathCalls: string[] } {
  const realPathCalls: string[] = [];
  return {
    realPathCalls,
    async readDir() {
      return [];
    },
    async isDirectory() {
      return false;
    },
    async realPath(dirPath: string) {
      realPathCalls.push(dirPath);
      return realPathImpl(dirPath);
    },
    async stat() {
      return undefined;
    },
    async readFile() {
      return undefined;
    },
    async readRange() {
      return undefined;
    },
    async readRangeBytes() {
      return undefined;
    },
  };
}

describe('createCwdResolver', () => {
  it('memoizes successful realPath results indefinitely', async () => {
    const rawCwd = '/tmp/shared';
    const resolvedCwd = '/private/tmp/shared';
    const fs = createFakeFs(async (dirPath) =>
      dirPath === rawCwd ? resolvedCwd : dirPath,
    );
    const resolver = createCwdResolver(fs);

    expect(await resolver.resolveCwd(rawCwd)).toBe(resolvedCwd);
    expect(await resolver.resolveCwd(rawCwd)).toBe(resolvedCwd);

    expect(fs.realPathCalls).toEqual([rawCwd]);
  });

  it('does not retry realPath before negative TTL expires', async () => {
    const rawCwd = '/tmp/broken';
    let now = 1_000;
    let shouldThrow = true;
    const fs = createFakeFs(async (dirPath) => {
      if (shouldThrow) {
        throw new Error('realPath failed');
      }
      return dirPath === rawCwd ? '/tmp/fixed' : dirPath;
    });
    const resolver = createCwdResolver(fs, {
      negativeTtlMs: 30_000,
      now: () => now,
    });

    expect(await resolver.resolveCwd(rawCwd)).toBe(rawCwd);
    shouldThrow = false;
    now += 10_000;
    expect(await resolver.resolveCwd(rawCwd)).toBe(rawCwd);

    expect(fs.realPathCalls).toEqual([rawCwd]);
  });

  it('retries realPath after negative TTL expires and picks up new result', async () => {
    const rawCwd = '/tmp/broken';
    let now = 1_000;
    let shouldThrow = true;
    const fs = createFakeFs(async (dirPath) => {
      if (shouldThrow) {
        throw new Error('realPath failed');
      }
      return dirPath === rawCwd ? '/tmp/fixed' : dirPath;
    });
    const resolver = createCwdResolver(fs, {
      negativeTtlMs: 30_000,
      now: () => now,
    });

    expect(await resolver.resolveCwd(rawCwd)).toBe(rawCwd);

    shouldThrow = false;
    now += 30_001;
    expect(await resolver.resolveCwd(rawCwd)).toBe('/tmp/fixed');

    expect(fs.realPathCalls).toEqual([rawCwd, rawCwd]);
  });
});
