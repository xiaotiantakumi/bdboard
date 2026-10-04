import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveIssueDraftsDir } from './resolve-issue-drafts-dir.js';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-issue-drafts-dir-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('resolveIssueDraftsDir (bdboard-4y8q.1)', () => {
  it('defaults to <repoRoot>/data/issue-drafts when .git is a directory (git clone)', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.git'));
    expect(resolveIssueDraftsDir(root, {})).toBe(path.join(root, 'data', 'issue-drafts'));
  });

  it('defaults to <repoRoot>/data/issue-drafts when .git is a file (linked worktree)', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(resolveIssueDraftsDir(root, {})).toBe(path.join(root, 'data', 'issue-drafts'));
  });

  it('defaults to ~/.bdboard/issue-drafts when .git does not exist (npm/npx install, same rule as attachments)', () => {
    const root = makeTempDir();
    expect(resolveIssueDraftsDir(root, {})).toBe(path.join(os.homedir(), '.bdboard', 'issue-drafts'));
  });

  it('uses BDBOARD_ISSUE_DRAFTS_DIR (resolved to absolute) over either default', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.git'));
    const override = path.join(makeTempDir(), 'custom-drafts');
    expect(resolveIssueDraftsDir(root, { BDBOARD_ISSUE_DRAFTS_DIR: override })).toBe(override);
    expect(resolveIssueDraftsDir(root, { BDBOARD_ISSUE_DRAFTS_DIR: 'relative/drafts' })).toBe(
      path.resolve('relative/drafts'),
    );
  });

  it('treats an empty BDBOARD_ISSUE_DRAFTS_DIR as unset', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.git'));
    expect(resolveIssueDraftsDir(root, { BDBOARD_ISSUE_DRAFTS_DIR: '' })).toBe(
      path.join(root, 'data', 'issue-drafts'),
    );
  });

  it('is not affected by BDBOARD_ATTACHMENTS_DIR', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.git'));
    expect(resolveIssueDraftsDir(root, { BDBOARD_ATTACHMENTS_DIR: '/elsewhere/attachments' })).toBe(
      path.join(root, 'data', 'issue-drafts'),
    );
  });
});
