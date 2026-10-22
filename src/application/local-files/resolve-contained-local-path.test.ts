import { mkdir, mkdtemp, realpath, rm, stat as fsStat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileSystemPort } from '../ports/file-system.js';
import { resolveContainedLocalPath, toLocalFileRef } from './resolve-contained-local-path.js';

const fileSystem: Pick<FileSystemPort, 'tryRealPath' | 'stat' | 'isDirectory'> = {
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
};

/** os.tmpdir() は realpath しない。macOS では /var が /private/var へのリンク。 */
let base = '';
let root = '';
let outside = '';

async function createFixture(rootDir: string, outsideDir: string): Promise<void> {
  await mkdir(path.join(rootDir, 'script'), { recursive: true });
  await mkdir(path.join(rootDir, 'out', 'stills'), { recursive: true });
  await mkdir(path.join(rootDir, '静止画'), { recursive: true });
  await mkdir(path.join(rootDir, 'docs'), { recursive: true });
  await mkdir(path.join(rootDir, '.git'), { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(path.join(rootDir, 'script', 'scenes.json'), '{}');
  await writeFile(path.join(rootDir, 'out', 'stills', 's01.png'), 'x');
  await writeFile(path.join(rootDir, '静止画', 'サムネ.png'), 'png');
  await writeFile(path.join(rootDir, 'docs', 'a.md'), 'md');
  await writeFile(path.join(rootDir, '.env'), 'SECRET=1');
  await writeFile(path.join(rootDir, '.git', 'config'), '');
  await writeFile(path.join(rootDir, '.git', 'config.md'), 'git');
  await writeFile(path.join(rootDir, '.git', 'HEAD.md'), 'head');
  await writeFile(path.join(rootDir, 'x.svg'), '<svg/>');
  await writeFile(path.join(rootDir, 'a.svg'), '<svg/>');
  await writeFile(path.join(rootDir, 'a.html'), '<p>');
  await writeFile(path.join(rootDir, 'a.ts'), 'export {}');
  await writeFile(path.join(outsideDir, 'secret.md'), 'secret');

  await symlink(path.join('docs', 'a.md'), path.join(rootDir, 'alias.md'));
  await symlink(path.join(rootDir, '.git'), path.join(rootDir, 'docs', 'gitlink'));
  await symlink(path.join(rootDir, '.git', 'config.md'), path.join(rootDir, 'notes.md'));
  await symlink(path.join(rootDir, 'x.svg'), path.join(rootDir, 'pic.png'));
  await symlink(path.join(outsideDir, 'secret.md'), path.join(rootDir, 'out-link.md'));
  await symlink(path.join(rootDir, 'out', 'stills', 's01.png'), path.join(rootDir, 'data.json'));
}

describe('resolveContainedLocalPath', () => {
  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'bdboard-local-files-'));
    root = path.join(base, '動画生成');
    outside = path.join(base, 'outside');
    await createFixture(root, outside);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('resolves a json file inside a root whose name is not ASCII', async () => {
    const realRoot = await realpath(root);
    const realPath = path.join(realRoot, 'script', 'scenes.json');
    const resolved = await resolveContainedLocalPath(fileSystem, root, 'script/scenes.json');
    expect(resolved).toEqual({
      ok: true,
      relativePath: 'script/scenes.json',
      realPath,
      isDirectory: false,
      kind: 'json',
      contentType: 'application/json; charset=utf-8',
      size: 2,
      mtimeMs: (await fsStat(realPath)).mtimeMs,
    });
    expect(resolved.ok && resolved.realPath.startsWith(realRoot + path.sep)).toBe(true);
  });

  it('resolves a directory and drops one trailing slash', async () => {
    const realRoot = await realpath(root);
    const resolved = await resolveContainedLocalPath(fileSystem, root, 'out/stills/');
    expect(resolved).toEqual({
      ok: true,
      relativePath: 'out/stills',
      realPath: path.join(realRoot, 'out', 'stills'),
      isDirectory: true,
      kind: 'directory',
      size: null,
    });
    expect(resolved.ok && resolved.realPath.startsWith(realRoot + path.sep)).toBe(true);
  });

  it('resolves an image whose path contains non-ASCII segments', async () => {
    const realRoot = await realpath(root);
    const realPath = path.join(realRoot, '静止画', 'サムネ.png');
    const resolved = await resolveContainedLocalPath(fileSystem, root, '静止画/サムネ.png');
    expect(resolved).toEqual({
      ok: true,
      relativePath: '静止画/サムネ.png',
      realPath,
      isDirectory: false,
      kind: 'image',
      contentType: 'image/png',
      size: 3,
      mtimeMs: (await fsStat(realPath)).mtimeMs,
    });
    expect(resolved.ok && resolved.realPath.startsWith(realRoot + path.sep)).toBe(true);
  });

  it('keeps the requested relative path when a symlink stays inside the root', async () => {
    const realRoot = await realpath(root);
    const realPath = path.join(realRoot, 'docs', 'a.md');
    const resolved = await resolveContainedLocalPath(fileSystem, root, 'alias.md');
    expect(resolved).toEqual({
      ok: true,
      relativePath: 'alias.md',
      realPath,
      isDirectory: false,
      kind: 'markdown',
      contentType: 'text/markdown; charset=utf-8',
      size: 2,
      mtimeMs: (await fsStat(realPath)).mtimeMs,
    });
    expect(resolved.ok && resolved.realPath.startsWith(realRoot + path.sep)).toBe(true);
  });

  it('rejects an absolute path', async () => {
    const resolved = await resolveContainedLocalPath(
      fileSystem,
      root,
      path.join(outside, 'secret.md'),
    );
    expect(resolved).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each<[string, 'invalid' | 'not-found' | 'unsupported-type']>([
    ['../outside/secret.md', 'invalid'],
    ['~/a.md', 'invalid'],
    ['.env', 'invalid'],
    ['.git/config', 'invalid'],
    ['out-link.md', 'not-found'],
    ['docs/gitlink/HEAD.md', 'not-found'],
    ['notes.md', 'not-found'],
    ['pic.png', 'unsupported-type'],
    ['data.json', 'unsupported-type'],
    ['a.svg', 'unsupported-type'],
    ['a.html', 'unsupported-type'],
    ['a.ts', 'unsupported-type'],
    ['missing.md', 'not-found'],
    ['a\0b.md', 'invalid'],
    ['docs\\a.md', 'invalid'],
    ['', 'invalid'],
  ])('rejects %j as %s', async (requestedPath, reason) => {
    const resolved = await resolveContainedLocalPath(fileSystem, root, requestedPath);
    expect(resolved).toEqual({ ok: false, reason });
  });

  it('fails closed when the target real path cannot be resolved even though stat would follow it', async () => {
    // A fake that echoed the input would let 'script/scenes.json' through: it starts with root/ and stat succeeds.
    const unresolvable: Pick<FileSystemPort, 'tryRealPath' | 'stat' | 'isDirectory'> = {
      ...fileSystem,
      async tryRealPath(targetPath) {
        return targetPath === root ? root : undefined;
      },
    };
    expect(await resolveContainedLocalPath(unresolvable, root, 'script/scenes.json')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('fails closed when the root real path cannot be resolved', async () => {
    const rootUnresolvable: Pick<FileSystemPort, 'tryRealPath' | 'stat' | 'isDirectory'> = {
      ...fileSystem,
      async tryRealPath(targetPath) {
        return targetPath === root ? undefined : fileSystem.tryRealPath(targetPath);
      },
    };
    expect(await resolveContainedLocalPath(rootUnresolvable, root, 'script/scenes.json')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('rejects a target that is not a regular file', async () => {
    const fifoLike: Pick<FileSystemPort, 'tryRealPath' | 'stat' | 'isDirectory'> = {
      ...fileSystem,
      async stat(targetPath) {
        const info = await fileSystem.stat(targetPath);
        return info === undefined ? undefined : { ...info, isFile: false };
      },
    };
    expect(await resolveContainedLocalPath(fifoLike, root, 'script/scenes.json')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('toLocalFileRef', () => {
  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'bdboard-local-files-'));
    root = path.join(base, '動画生成');
    outside = path.join(base, 'outside');
    await createFixture(root, outside);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('maps a resolved file to a ref', async () => {
    const contained = await resolveContainedLocalPath(fileSystem, root, 'script/scenes.json');
    expect(toLocalFileRef(contained)).toEqual({
      path: 'script/scenes.json',
      kind: 'json',
      size: 2,
    });
  });

  it('maps a resolved directory to a ref', async () => {
    const contained = await resolveContainedLocalPath(fileSystem, root, 'out/stills/');
    expect(toLocalFileRef(contained)).toEqual({
      path: 'out/stills',
      kind: 'directory',
      size: null,
    });
  });

  it('returns undefined when containment failed', async () => {
    const contained = await resolveContainedLocalPath(fileSystem, root, '.env');
    expect(contained).toEqual({ ok: false, reason: 'invalid' });
    expect(toLocalFileRef(contained)).toBeUndefined();
  });
});
