import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveExternalIssuesDir } from './resolve-external-issues-dir.js';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-external-issues-dir-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('resolveExternalIssuesDir (bdboard-4y8q.9.3)', () => {
  it('is <repoRoot>/data/external-issues when .git is a directory (git clone)', () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.git'));
    expect(resolveExternalIssuesDir(root)).toBe(path.join(root, 'data', 'external-issues'));
  });

  it('is <repoRoot>/data/external-issues when .git is a file (linked worktree)', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(resolveExternalIssuesDir(root)).toBe(path.join(root, 'data', 'external-issues'));
  });

  it('is ~/.bdboard/external-issues when .git does not exist (npm/npx install, same base as the drafts)', () => {
    const root = makeTempDir();
    expect(resolveExternalIssuesDir(root)).toBe(path.join(os.homedir(), '.bdboard', 'external-issues'));
  });
});
