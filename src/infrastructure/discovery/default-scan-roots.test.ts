import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import { resolveDefaultScanRoots } from './default-scan-roots.js';

function createFakeFs(directories: ReadonlySet<string>): FileSystemPort {
  return {
    readDir: async () => [],
    isDirectory: async (targetPath) => directories.has(targetPath),
    realPath: async (targetPath) => targetPath,
    stat: async () => undefined,
    readFile: async () => undefined,
    readRange: async () => undefined,
    readRangeBytes: async () => undefined,
  };
}

describe('resolveDefaultScanRoots', () => {
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  it.each([
    ['darwin', 'darwin'],
    ['linux', 'linux'],
  ] as const)('%s: returns Documents when it exists', async (_label, platform) => {
    const home = '/home/testuser';
    const documents = path.join(home, 'Documents');
    const fs = createFakeFs(new Set([documents]));

    const roots = await resolveDefaultScanRoots(fs, { platform, homedir: home });

    expect(roots).toEqual([documents]);
  });

  it.each([
    ['darwin', 'darwin'],
    ['linux', 'linux'],
  ] as const)('%s: falls back to home when Documents does not exist', async (_label, platform) => {
    const home = '/home/testuser';
    const fs = createFakeFs(new Set());

    const roots = await resolveDefaultScanRoots(fs, { platform, homedir: home });

    expect(roots).toEqual([home]);
  });

  it('win32: uses USERPROFILE when set', async () => {
    process.env.USERPROFILE = 'C:\\Users\\TestUser';
    const home = 'C:\\Users\\TestUser';
    const documents = path.join(home, 'Documents');
    const fs = createFakeFs(new Set([documents]));

    const roots = await resolveDefaultScanRoots(fs, { platform: 'win32' });

    expect(roots).toEqual([documents]);
  });

  it('win32: falls back to os.homedir() when USERPROFILE is unset', async () => {
    delete process.env.USERPROFILE;
    const home = os.homedir();
    const documents = path.join(home, 'Documents');
    const fs = createFakeFs(new Set([documents]));

    const roots = await resolveDefaultScanRoots(fs, { platform: 'win32' });

    expect(roots).toEqual([documents]);
  });

  it('win32: falls back to os.homedir() when USERPROFILE is empty', async () => {
    process.env.USERPROFILE = '   ';
    const home = os.homedir();
    const documents = path.join(home, 'Documents');
    const fs = createFakeFs(new Set());

    const roots = await resolveDefaultScanRoots(fs, { platform: 'win32' });

    expect(roots).toEqual([home]);
  });
});
