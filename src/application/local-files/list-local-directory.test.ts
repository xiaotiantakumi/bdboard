import { mkdir, mkdtemp, readdir, realpath, rm, stat as fsStat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileSystemPort } from '../ports/file-system.js';
import { listLocalDirectory } from './list-local-directory.js';

const fileSystem: Pick<FileSystemPort, 'tryRealPath' | 'stat' | 'isDirectory' | 'readDir'> = {
  async tryRealPath(targetPath) {
    try {
      return await realpath(targetPath);
    } catch {
      return undefined;
    }
  },
  async stat(targetPath) {
    try {
      const info = await fsStat(targetPath);
      return { mtimeMs: info.mtimeMs, size: info.size, isFile: info.isFile() };
    } catch {
      return undefined;
    }
  },
  async isDirectory(targetPath) {
    try {
      return (await fsStat(targetPath)).isDirectory();
    } catch {
      return false;
    }
  },
  async readDir(targetPath) {
    const entries = await readdir(targetPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  },
};

/** s1.png は 3 バイト。s2.png は 2、s10.png は 1、readme.md（inside.md の実体）は 5。 */
const STILLS_ENTRIES = [
  { name: 'inside.md', path: 'out/13-demo/stills/inside.md', kind: 'markdown', size: 5 },
  { name: 's1.png', path: 'out/13-demo/stills/s1.png', kind: 'image', size: 3 },
  { name: 's2.png', path: 'out/13-demo/stills/s2.png', kind: 'image', size: 2 },
  { name: 's10.png', path: 'out/13-demo/stills/s10.png', kind: 'image', size: 1 },
  { name: 'sub', path: 'out/13-demo/stills/sub', kind: 'directory', size: null },
] as const;

let base = '';
let root = '';
let outside = '';

async function createFixture(rootDir: string, outsideDir: string): Promise<void> {
  const stills = path.join(rootDir, 'out', '13-demo', 'stills');
  await mkdir(path.join(stills, 'sub'), { recursive: true });
  await mkdir(path.join(stills, '.cache'), { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(path.join(stills, 's1.png'), 'abc');
  await writeFile(path.join(stills, 's2.png'), 'de');
  await writeFile(path.join(stills, 's10.png'), 'f');
  await writeFile(path.join(stills, '.hidden.png'), 'hid');
  await writeFile(path.join(stills, 'notes.ts'), 'export {}');
  await writeFile(path.join(stills, 'a.svg'), '<svg/>');
  await writeFile(path.join(rootDir, 'out', '13-demo', 'readme.md'), 'notes');
  await writeFile(path.join(outsideDir, 'x.png'), 'out');

  await symlink(path.join('..', 'readme.md'), path.join(stills, 'inside.md'));
  await symlink(path.join(outsideDir, 'x.png'), path.join(stills, 'link.png'));
}

describe('listLocalDirectory', () => {
  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'bdboard-list-'));
    root = path.join(base, '動画生成');
    outside = path.join(base, 'outside');
    await createFixture(root, outside);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('lists allowed entries in natural order and drops one trailing slash', async () => {
    expect(await listLocalDirectory(fileSystem, root, 'out/13-demo/stills/')).toEqual({
      ok: true,
      path: 'out/13-demo/stills',
      entries: STILLS_ENTRIES,
      truncated: false,
    });
  });

  it('rejects a file as not a directory', async () => {
    expect(await listLocalDirectory(fileSystem, root, 'out/13-demo/readme.md')).toEqual({
      ok: false,
      reason: 'not-a-directory',
    });
  });

  it.each([
    ['../outside', 'invalid'],
    ['out/13-demo/stills/.cache', 'invalid'],
    ['out/missing', 'not-found'],
    ['out/13-demo/stills/notes.ts', 'unsupported-type'],
  ] as const)('rejects %s as %s', async (requestedPath, reason) => {
    expect(await listLocalDirectory(fileSystem, root, requestedPath)).toEqual({
      ok: false,
      reason,
    });
  });

  it('sets truncated only when kept entries hit the limit with candidates left', async () => {
    expect(await listLocalDirectory(fileSystem, root, 'out/13-demo/stills', 2)).toEqual({
      ok: true,
      path: 'out/13-demo/stills',
      entries: [STILLS_ENTRIES[0], STILLS_ENTRIES[1]],
      truncated: true,
    });
    expect(await listLocalDirectory(fileSystem, root, 'out/13-demo/stills', 5)).toEqual({
      ok: true,
      path: 'out/13-demo/stills',
      entries: STILLS_ENTRIES,
      truncated: false,
    });
  });

  it('maps a readDir failure to not-found', async () => {
    const unreadable: Pick<FileSystemPort, 'tryRealPath' | 'stat' | 'isDirectory' | 'readDir'> = {
      ...fileSystem,
      readDir() {
        return Promise.reject(new Error('unreadable'));
      },
    };
    expect(await listLocalDirectory(unreadable, root, 'out/13-demo/stills')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});
