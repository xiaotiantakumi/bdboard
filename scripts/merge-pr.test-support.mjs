// bdboard-4dqo: scripts/merge-pr*.test.mjs が共有する harness (一時リポジトリ + 偽の gh / bd / npm)。
// もとは scripts/merge-pr.test.mjs の describe 内にあった setup / run / simulateMerge などを、
// 1500 行の max-lines (テスト扱い) に余裕を作るためここへ出した純粋な移動で、挙動は変えていない。
//
// 状態 (tmp / work / env / base / head ...) は setup() が毎回作り直すので、モジュール内の `export let`
// (ESM の live binding) で公開する。テストファイル側は import したまま常に最新の値を読む
// (代入できるのはこのモジュールの setup() と registerTempRepoHooks() のフックだけで、import 側は
// 代入できない)。vitest は既定 (isolate: true) でテストファイルごとにモジュールを読み直すので
// ファイル間で状態は共有されない。isolate を切っても setup() が毎回すべて作り直すので壊れない。
// 名前はリポジトリのテスト専用モジュールの慣習 (*.test-support.*) に合わせた。vitest の include
// (scripts/**/*.test.mjs) にも eslint のテスト扱い (**/*.test.mjs) にも当たらない。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach } from 'vitest';

import { VERIFY_JS } from './merge-pr.test-support-verify-js.mjs';

export const SCRIPT = fileURLToPath(new URL('./merge-pr.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./merge-pr/fake-tools.mjs', import.meta.url));
export const REPO_ROOT = path.dirname(path.dirname(SCRIPT));
export const CONTEXT = 'bdboard/landed-verify';
export const PR = 7;
export const TITLE = 'feat(demo-1): add the thing';

// bdboard-2twf: SIGINT テスト用の小さなヘルパー。pidAlive は scripts/process-identity.mjs の isProcessAlive と
// 同じ判定 (EPERM = 居るが触れない = alive、ESRCH = もう居ない)。テストの確認は本体と別の実装で行う。
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function waitUntil(predicate, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export let tmp;
export let mainCheckout;
export let work;
export let fakeState;
export let env;
export let base;
export let head;

export function git(cwd, args, extraEnv = {}) {
  const result = spawnSync('git', args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export const readFake = () => JSON.parse(readFileSync(fakeState, 'utf8'));
export const writeFake = (patch) => writeFileSync(fakeState, JSON.stringify({ ...readFake(), ...patch }, null, 2));
export const calls = (tool, sub) => readFake().calls.filter((call) => call[0] === tool && (sub === undefined || call.includes(sub)));
export const posted = () => readFake().posted ?? [];
export const verified = () => (existsSync(env.FAKE_VERIFY_LOG) ? readFileSync(env.FAKE_VERIFY_LOG, 'utf8').trim().split('\n') : []);
export const auditText = () => (existsSync(env.BDBOARD_MERGE_AUDIT_LOG) ? readFileSync(env.BDBOARD_MERGE_AUDIT_LOG, 'utf8') : '');
// 状態は git common dir (= main checkout の .git) に置かれ、全 worktree から見える。
export const stateFile = () => path.join(mainCheckout, '.git', 'bdboard-merge', `pr-${PR}.json`);
export const status = (state, updatedAt = new Date().toISOString()) => ({ state, context: CONTEXT, description: state, updated_at: updatedAt });

export function run(args, extraEnv = {}, cwd = work) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function commitAll(cwd, message, extraEnv = {}) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message], extraEnv);
  return git(cwd, ['rev-parse', 'HEAD']);
}

/**
 * origin (bare)・main checkout 役の mainCheckout・そこから git worktree add した PR worktree の
 * work を作る。main の先頭 (= PRED_BASE) は mainDate の時刻。work は bd/demo-1
 * (feature.txt を足した 1 コミット) を checkout した状態で返す。
 */
export function setup({ merge = {}, mainDate, branchFiles = {} } = {}) {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
  tmp = mkdtempSync(path.join(tmpdir(), 'bdboard-merge-pr-'));
  const origin = path.join(tmp, 'origin.git');
  mainCheckout = path.join(tmp, 'main');
  work = path.join(tmp, 'work');
  fakeState = path.join(tmp, 'fake-state.json');
  mkdirSync(path.join(tmp, 'home'));
  const tool = (name) => JSON.stringify([process.execPath, FAKE, name]);
  env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(tmp, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'bdboard-test',
    GIT_AUTHOR_EMAIL: 'bdboard-test@example.invalid',
    GIT_COMMITTER_NAME: 'bdboard-test',
    GIT_COMMITTER_EMAIL: 'bdboard-test@example.invalid',
    BDBOARD_MERGE_GH: tool('gh'),
    BDBOARD_MERGE_BD: tool('bd'),
    BDBOARD_MERGE_NPM: tool('npm'),
    BDBOARD_MERGE_FAKE_STATE: fakeState,
    BDBOARD_MERGE_AUDIT_LOG: path.join(tmp, 'audit.log'),
    BDBOARD_MERGE_POLL_MS: '50',
    BDBOARD_MERGER: 'chair',
    FAKE_VERIFY_LOG: path.join(tmp, 'verified.log'),
  };
  git(tmp, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(tmp, ['init', '-q', '-b', 'main', mainCheckout]);
  const contract = {
    version: 1,
    verify: 'node verify.cjs',
    prFlow: 'pr',
    merge: { mode: 'S1', leaseMinutes: 1, slotWaitMinutes: 1, statusContext: CONTEXT, repo: 'example/demo', ...merge },
  };
  mkdirSync(path.join(mainCheckout, '.claude'));
  writeFileSync(path.join(mainCheckout, '.claude', 'bdboard-harness.json'), `${JSON.stringify(contract, null, 2)}\n`);
  writeFileSync(path.join(mainCheckout, 'verify.cjs'), VERIFY_JS);
  writeFileSync(path.join(mainCheckout, 'README.md'), 'demo\n');
  base = commitAll(mainCheckout, 'chore: init', mainDate ? { GIT_COMMITTER_DATE: mainDate } : {});
  git(mainCheckout, ['remote', 'add', 'origin', origin]);
  git(mainCheckout, ['push', '-q', 'origin', 'main']);
  git(mainCheckout, ['worktree', 'add', '-q', '-b', 'bd/demo-1', work, 'main']);
  writeFileSync(path.join(work, 'feature.txt'), 'feature\n');
  for (const [file, content] of Object.entries(branchFiles)) {
    const dest = path.join(work, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  head = commitAll(work, TITLE);
  git(work, ['push', '-q', 'origin', 'bd/demo-1']);
  writeFileSync(
    fakeState,
    JSON.stringify({
      pulls: {
        [PR]: { number: PR, state: 'open', merged: false, merge_commit_sha: null, title: TITLE, body: '', draft: false, head: { sha: head, ref: 'bd/demo-1' }, base: { ref: 'main' } },
      },
      statuses: { [base]: [status('success')] },
      bdShow: { 'demo-1': [{ metadata: { 'bdboard.model.review': 'opus-5' } }] },
      slot: { holder: null },
      calls: [],
    }),
  );
}

/** gh pr merge の代わりに squash マージを origin に着地させ、PR をマージ済みにする。 */
export function simulateMerge() {
  const tree = git(work, ['rev-parse', 'HEAD^{tree}']);
  const landed = git(work, ['commit-tree', tree, '-p', base, '-m', `${TITLE} (#${PR})`]);
  git(work, ['push', '-q', 'origin', `${landed}:refs/heads/main`]);
  const fake = readFake();
  fake.pulls[PR] = { ...fake.pulls[PR], state: 'closed', merged: true, merge_commit_sha: landed };
  writeFileSync(fakeState, JSON.stringify(fake));
  return landed;
}

/** main を base から 1 コミット進めた commit を作る (push はしない)。 */
export function peerCommit() {
  return git(work, ['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'feat(peer): landed meanwhile']);
}

/** main checkout 役から origin/main を 1 コミット進める (files: パス → 内容)。 */
export function advanceMain(files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(mainCheckout, file)), { recursive: true });
    writeFileSync(path.join(mainCheckout, file), content);
  }
  const sha = commitAll(mainCheckout, 'feat(peer): landed meanwhile');
  git(mainCheckout, ['push', '-q', 'origin', 'main']);
  return sha;
}

/** GitHub の squash の代役: 今の remote main に head を 3-way マージした木 (または tree) を 1 親で着地させる。 */
export function landSquash(tree) {
  const parent = git(work, ['ls-remote', 'origin', 'refs/heads/main']).split('\t')[0];
  const landedTree = tree ?? git(work, ['merge-tree', '--write-tree', parent, head]);
  const landed = git(work, ['commit-tree', landedTree, '-p', parent, '-m', `${TITLE} (#${PR})`]);
  git(work, ['push', '-q', 'origin', `${landed}:refs/heads/main`]);
  const fake = readFake();
  fake.pulls[PR] = { ...fake.pulls[PR], state: 'closed', merged: true, merge_commit_sha: landed };
  writeFileSync(fakeState, JSON.stringify(fake));
  return landed;
}

export const readState = () => JSON.parse(readFileSync(stateFile(), 'utf8'));

/** describe の中で呼び、テストごとに一時ディレクトリを後始末する。 */
export function registerTempRepoHooks() {
  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    tmp = undefined;
  });

  beforeEach(() => {
    tmp = undefined;
  });
}
