// bdboard-w8hr: scripts/test-support/quiet-git.mjs の確認。一時 repo の git が自動保守 (`git maintenance` / `git gc`) を
// 起こさないことを、設定と、実際に起きる git の子プロセス (GIT_TRACE2_EVENT の cmd_name) の両方で確かめる。
// scripts/merge-pr.test-support.test.mjs (bdboard-myla) の形にならう。repo 側には何も設定せず、global の gitconfig
// だけで効くことを見る。対照 (保守は起きるが前景で走る gitconfig) では保守が起きる = 計測が本当に働いている、も同じテストで見る。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
// stderr は握る (空の bare を clone すると "You appear to have cloned an empty repository." が出てテスト出力が汚れる)。
const git = (cwd, args, env) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

  it('applies every setting globally to fresh, bare and cloned repositories with no per-repo config', () => {
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
      expect(git(repo, ['config', '--get', 'maintenance.autoDetach'], env), repo).toBe('false');
      expect(git(repo, ['config', '--get', 'gc.auto'], env), repo).toBe('0');
      expect(git(repo, ['config', '--get', 'gc.autoDetach'], env), repo).toBe('false');
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

  it('spawns no `git maintenance` / `git gc` while committing, pushing, receiving and fetching, and a foreground-only gitconfig does', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'bdboard-quiet-git-'));
    const quietNames = traceSequence(tmp, envFor(tmp), path.join(tmp, 'quiet-trace.jsonl'));
    expect(quietNames).toEqual(expect.arrayContaining(['commit', 'push', 'receive-pack', 'fetch'])); // 計測自体が働いている
    expect(maintenanceNames(quietNames)).toEqual([]);

    // 対照: auto は止めず、前景で走らせるだけの設定 (autoDetach=false) にすると保守が起きる。git の保守の起こし方が変わって
    // 計測が何も測らなくなったら、ここで落ちて気づける。前景で走るので親の git が戻った時点で終わっており、この一時 repo の
    // 後始末とは競合しない (detach する既定のままだと、このテスト自身が同じ ENOTEMPTY の競合を持ち込む)。
    const controlRoot = path.join(tmp, 'control');
    mkdirSync(controlRoot);
    const foregroundConfig = path.join(controlRoot, 'foreground.gitconfig');
    writeFileSync(foregroundConfig, '[maintenance]\n\tautoDetach = false\n[gc]\n\tautoDetach = false\n');
    const controlNames = traceSequence(
      controlRoot,
      envFor(controlRoot, { GIT_CONFIG_GLOBAL: foregroundConfig }),
      path.join(controlRoot, 'control-trace.jsonl'),
    );
    expect(controlNames).toEqual(expect.arrayContaining(['commit', 'push', 'receive-pack', 'fetch']));
    expect(maintenanceNames(controlNames).length).toBeGreaterThan(0);
  });
});

describe('useQuietGitProcessEnv restores the environment (bdboard-w8hr)', () => {
  it('puts GIT_CONFIG_GLOBAL back to its original value once the suite above has finished', () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(originalGlobalConfig);
  });
});

// bdboard-sl0n: 復元のケース B。同じ suite で useQuietGitProcessEnv の後に登録された別の beforeAll が失敗しても元に戻る。
// beforeAll を失敗させるとそのファイルが失敗扱いになるので、題材 (scripts/fixtures/quiet-git-sibling-hook-failure.fixture.mjs) を
// 子の vitest プロセスで流して結果 (JSON reporter) を読む。題材は *.test.mjs ではないので、このリポジトリの include には入らない。
// 子には最小の設定 (root と include だけ。globalSetup なし) を一時ファイルで渡し、リポジトリの vitest.config.ts は読ませない。
// 戻り値の cleanup を返す形 (beforeAll が返した cleanup は、後から登録された beforeAll が失敗すると捨てられる) に戻すと、ここが落ちる。
describe('useQuietGitProcessEnv restores the environment when a sibling beforeAll fails (bdboard-sl0n)', { timeout: 60_000 }, () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const fixture = 'scripts/fixtures/quiet-git-sibling-hook-failure.fixture.mjs';
  let tmp;
  afterEach(() => {
    if (tmp) {
      rmSync(tmp, RM_OPTIONS);
    }
  });

  it('puts GIT_CONFIG_GLOBAL back and removes the temporary gitconfig even though the file fails', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'bdboard-quiet-git-child-'));
    const configPath = path.join(tmp, 'vitest.config.mjs');
    const reportPath = path.join(tmp, 'report.json');
    writeFileSync(configPath, `export default ${JSON.stringify({ root: repoRoot, test: { include: [fixture], testTimeout: 30_000 } })};\n`);
    const child = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', configPath, '--reporter=json', `--outputFile=${reportPath}`, '--maxWorkers=1'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 50_000 },
    );
    const output = `exit=${child.status} signal=${child.signal}\n${child.stdout}\n${child.stderr}`;
    expect(existsSync(reportPath), `the child vitest wrote no report:\n${output}`).toBe(true);
    const files = JSON.parse(readFileSync(reportPath, 'utf8')).testResults;
    expect(files, output).toHaveLength(1);
    const titled = (title) => files[0].assertionResults.find((assertion) => assertion.title === title);

    // 子が失敗を起こせている (起こせていないと、復元を確かめたことにならない)。失敗した beforeAll の suite のテストは走らず、ファイルは
    // 失敗扱い (JSON reporter は beforeAll の例外の文面を載せない。失敗の中身は、題材が失敗する beforeAll の中で値を控えたことで確かめる)。
    expect(files[0].status, output).toBe('failed');
    expect(titled('sibling beforeAll registered after it fails')?.status, output).toBe('skipped');
    // 失敗した suite の後で、元の値に戻り、一時の gitconfig の dir が消えている (題材の側の expect。落ちたらその文面を出す)。
    const restored = titled('restores GIT_CONFIG_GLOBAL and removes the temporary gitconfig directory');
    expect(restored, output).toBeDefined();
    expect(restored.status, `${restored.failureMessages.join('\n')}\n${output}`).toBe('passed');
  });
});
