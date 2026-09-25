import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDataDirBase } from './resolve-data-dir-base.js';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-data-dir-base-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('resolveDataDirBase (bdboard-727y)', () => {
  it('bases on <repoRoot>/data when .git is a directory (git clone / main checkout)', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.git'));
    expect(resolveDataDirBase(root)).toBe(path.join(root, 'data'));
  });

  it('bases on <repoRoot>/data when .git is a file (linked worktree)', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(resolveDataDirBase(root)).toBe(path.join(root, 'data'));
  });

  it('bases on ~/.bdboard when .git does not exist (npm/npx install)', () => {
    const root = makeTempDir();
    expect(resolveDataDirBase(root)).toBe(path.join(os.homedir(), '.bdboard'));
  });
});
