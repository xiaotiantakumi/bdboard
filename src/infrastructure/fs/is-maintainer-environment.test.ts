import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isMaintainerEnvironment } from './is-maintainer-environment.js';

const temporaryDirectories: string[] = [];

function makeRepoRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainer-env-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('isMaintainerEnvironment', () => {
  it('is true when <repoRoot>/.beads exists', () => {
    const root = makeRepoRoot();
    fs.mkdirSync(path.join(root, '.beads'));

    expect(isMaintainerEnvironment(root)).toBe(true);
  });

  it('is false when there is no .beads (a clone or a worktree)', () => {
    expect(isMaintainerEnvironment(makeRepoRoot())).toBe(false);
  });

  it('is false for a directory that does not exist', () => {
    expect(isMaintainerEnvironment(path.join(makeRepoRoot(), 'missing'))).toBe(false);
  });
});
