// bdboard-w8hr: scripts/test-support/quiet-git.mjs の確認。一時 repo の git が自動保守 (`git maintenance` / `git gc`) を
// 起こさないことを、設定と、実際に起きる git の子プロセス (GIT_TRACE2_EVENT の cmd_name) の両方で確かめる。
// scripts/merge-pr.test-support.test.mjs (bdboard-myla) の形にならう。repo 側には何も設定せず、global の gitconfig
// だけで効くことを見る。対照 (空の gitconfig) では保守が起きる = 計測が本当に働いている、も同じテストで見る。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { QUIET_GIT_CONFIG, quietGitEnv, RM_OPTIONS, useQuietGitProcessEnv } from './quiet-git.mjs';

const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;

const envFor = (dir, extra = {}) => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'bdboard-test',
  GIT_AUTHOR_EMAIL: 'bdboard-test@example.invalid',
  GIT_COMMITTER_NAME: 'bdboard-test',
  GIT_COMMITTER_EMAIL: 'bdboard-test@example.invalid',
  ...quietGitEnv(dir),
  ...extra,
});
const git = (cwd, args, env) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const initRepo = (repo, env, bare = false) => {
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main', ...(bare ? ['--bare'] : [])], env);
};
const commit = (repo, env, message) => {
  writeFileSync(path.join(repo, 'file.txt'), `${message}\n`);
  git(repo, ['add', 'file.txt'], env);
  git(repo, ['commit', '-q', '-m', message], env);
};

/** commit → push (受け側 receive-pack) → 別 clone で commit/push → fetch を流し、trace2 の cmd_name を全部返す。 */
function traceSequence(root, env, tracePath) {
  const traced = { ...env, GIT_TRACE2_EVENT: tracePath };
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const peer = path.join(root, 'peer');
  initRepo(origin, traced, true);
  initRepo(work, traced);
  git(work, ['remote', 'add', 'origin', origin], traced);
  commit(work, traced, 'first');
  git(work, ['push', '-q', '-u', 'origin', 'main'], traced);
  git(root, ['clone', '-q', origin, peer], traced);
  commit(peer, traced, 'second');
  git(peer, ['push', '-q', 'origin', 'main'], traced);
  git(work, ['fetch', '-q', 'origin'], traced);
  return readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"event":"cmd_name"'))
    .map((line) => JSON.parse(line).name);
}
const maintenanceNames = (names) => names.filter((name) => name === 'maintenance' || name === 'gc');

describe('quiet git config (bdboard-w8hr)', { timeout: 15_000 }, () => {
  useQuietGitProcessEnv();
  let tmp;
  afterEach(() => {
    if (tmp) {
      rmSync(tmp, RM_OPTIONS);
    }
  });

  it('applies all three settings globally to fresh, bare and cloned repositories with no per-repo config', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'bdboard-quiet-git-'));
    const env = envFor(tmp);
    expect(readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8')).toBe(QUIET_GIT_CONFIG);
    const fresh = path.join(tmp, 'fresh');
    const bare = path.join(tmp, 'origin.git');
    const clone = path.join(tmp, 'clone');
    initRepo(fresh, env);
    initRepo(bare, env, true);
    git(tmp, ['clone', '-q', bare, clone], env);
    for (const repo of [fresh, bare, clone]) {
      expect(git(repo, ['config', '--get', 'maintenance.auto'], env), repo).toBe('false');
      expect(git(repo, ['config', '--get', 'gc.auto'], env), repo).toBe('0');
      expect(git(repo, ['config', '--get', 'receive.autogc'], env), repo).toBe('false');
    }
  });

  it('useQuietGitProcessEnv makes git processes that inherit process.env quiet', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'bdboard-quiet-git-'));
    const repo = path.join(tmp, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    expect(readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8')).toBe(QUIET_GIT_CONFIG);
    expect(execFileSync('git', ['config', '--get', 'maintenance.auto'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('false');
  });

  it('spawns no `git maintenance` / `git gc` while committing, pushing, receiving and fetching, and an empty gitconfig does', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'bdboard-quiet-git-'));
    const quietNames = traceSequence(tmp, envFor(tmp), path.join(tmp, 'quiet-trace.jsonl'));
    expect(quietNames).toEqual(expect.arrayContaining(['commit', 'push', 'receive-pack', 'fetch'])); // 計測自体が働いている
    expect(maintenanceNames(quietNames)).toEqual([]);

    // 対照: 同じ手順で global を空にすると保守が起きる。git の保守の起こし方が変わって計測が何も測らなくなったら、ここで落ちて気づける。
    const controlRoot = path.join(tmp, 'control');
    mkdirSync(controlRoot);
    const emptyConfig = path.join(controlRoot, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
    const controlNames = traceSequence(controlRoot, envFor(controlRoot, { GIT_CONFIG_GLOBAL: emptyConfig }), path.join(controlRoot, 'control-trace.jsonl'));
    expect(controlNames).toEqual(expect.arrayContaining(['commit', 'push', 'receive-pack', 'fetch']));
    expect(maintenanceNames(controlNames).length).toBeGreaterThan(0);
  });
});

describe('useQuietGitProcessEnv restores the environment (bdboard-w8hr)', () => {
  it('puts GIT_CONFIG_GLOBAL back to its original value once the suite above has finished', () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(originalGlobalConfig);
  });
});
