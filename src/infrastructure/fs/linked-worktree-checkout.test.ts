import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLinkedWorktreeCheckout } from './linked-worktree-checkout.js';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-linked-worktree-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('isLinkedWorktreeCheckout', () => {
  it('returns false when .git is a directory', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.git'));
    expect(isLinkedWorktreeCheckout(root)).toBe(false);
  });

  it('recognizes a linked checkout in an arbitrary Codex-style path', () => {
    const root = path.join(makeTempDir(), 'codex-worktrees', 'abcd', 'bdboard');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(isLinkedWorktreeCheckout(root)).toBe(true);
  });

  it('returns false when .git does not exist', () => {
    expect(isLinkedWorktreeCheckout(makeTempDir())).toBe(false);
  });

  it('returns false when .git is a symlink to a directory (statSync follows the link)', () => {
    const root = makeTempDir();
    const realGitDir = path.join(root, 'real-git-dir');
    fs.mkdirSync(realGitDir);
    fs.symlinkSync(realGitDir, path.join(root, '.git'), 'dir');
    expect(isLinkedWorktreeCheckout(root)).toBe(false);
  });
});
