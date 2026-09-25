import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAttachmentsDir } from './resolve-attachments-dir.js';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-attachments-dir-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('resolveAttachmentsDir (bdboard-727y)', () => {
  it('defaults to <repoRoot>/data/attachments when .git is a directory (git clone)', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.git'));
    expect(resolveAttachmentsDir(root, {})).toBe(path.join(root, 'data', 'attachments'));
  });

  it('defaults to <repoRoot>/data/attachments when .git is a file (linked worktree)', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(resolveAttachmentsDir(root, {})).toBe(path.join(root, 'data', 'attachments'));
  });

  it('defaults to ~/.bdboard/attachments when .git does not exist (npm/npx install)', () => {
    const root = makeTempDir();
    expect(resolveAttachmentsDir(root, {})).toBe(
      path.join(os.homedir(), '.bdboard', 'attachments'),
    );
  });

  it('uses BDBOARD_ATTACHMENTS_DIR when set, regardless of .git presence', () => {
    const root = makeTempDir();
    const override = path.join(makeTempDir(), 'custom-attachments');
    expect(resolveAttachmentsDir(root, { BDBOARD_ATTACHMENTS_DIR: override })).toBe(override);
  });

  it('ignores an empty BDBOARD_ATTACHMENTS_DIR and falls back to the default', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.git'));
    expect(resolveAttachmentsDir(root, { BDBOARD_ATTACHMENTS_DIR: '' })).toBe(
      path.join(root, 'data', 'attachments'),
    );
  });
});
