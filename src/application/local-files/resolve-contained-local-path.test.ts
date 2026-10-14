import { mkdir, mkdtemp, realpath, rm, stat as fsStat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileSystemPort } from '../ports/file-system.js';
import { resolveContainedLocalPath, toLocalFileRef } from './resolve-contained-local-path.js';

const fileSystem: Pick<FileSystemPort, 'realPath' | 'stat' | 'isDirectory'> = {
  async realPath(targetPath) {
    try {
      return await realpath(targetPath);
    } catch {
      return targetPath;
    }
  },
  async stat(targetPath) {
    try {
      const info = await fsStat(targetPath);
      return { mtimeMs: info.mtimeMs, size: info.size };
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
    const resolved = await resolveContainedLocalPath(fileSystem, root, 'script/scenes.json');
    expect(resolved).toEqual({
      ok: true,
      relativePath: 'script/scenes.json',
      realPath: path.join(realRoot, 'script', 'scenes.json'),
      isDirectory: false,
      kind: 'json',
      contentType: 'application/json; charset=utf-8',
      size: 2,
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
    const resolved = await resolveContainedLocalPath(fileSystem, root, '静止画/サムネ.png');
    expect(resolved).toEqual({
      ok: true,
      relativePath: '静止画/サムネ.png',
      realPath: path.join(realRoot, '静止画', 'サムネ.png'),
      isDirectory: false,
      kind: 'image',
      contentType: 'image/png',
      size: 3,
    });
    expect(resolved.ok && resolved.realPath.startsWith(realRoot + path.sep)).toBe(true);
  });

  it('keeps the requested relative path when a symlink stays inside the root', async () => {
    const realRoot = await realpath(root);
    const resolved = await resolveContainedLocalPath(fileSystem, root, 'alias.md');
    expect(resolved).toEqual({
      ok: true,
      relativePath: 'alias.md',
      realPath: path.join(realRoot, 'docs', 'a.md'),
      isDirectory: false,
      kind: 'markdown',
      contentType: 'text/markdown; charset=utf-8',
      size: 2,
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
