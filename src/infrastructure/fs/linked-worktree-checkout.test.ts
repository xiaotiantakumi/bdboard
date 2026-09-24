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

  // bdboard-6h6n: documents the known false-positive cases (opus review nit on PR #695). The
  // detection stays as-is on purpose -- guarding too eagerly (requiring an explicit BDBOARD_DB)
  // is the safe direction to fail in, so these cases are left true. The caller-facing message
  // (MainCheckoutDbPathRequiredError in resolve-main-config.ts) was reworded instead to not
  // assert "linked worktree" outright; see resolve-main-config.test.ts for that coverage.
  it('also returns true for a git submodule checkout, since its .git is a file too (documented false positive)', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../.git/modules/some-submodule\n');
    expect(isLinkedWorktreeCheckout(root)).toBe(true);
  });

  it('also returns true for a --separate-git-dir clone, since its .git is a file too (documented false positive)', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere/separate-git-dir\n');
    expect(isLinkedWorktreeCheckout(root)).toBe(true);
  });
});
