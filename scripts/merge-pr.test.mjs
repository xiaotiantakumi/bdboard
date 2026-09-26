// bdboard-ulxa.1: scripts/merge-pr (マージ手順 S1 の prepare / gate / finish) のテスト。
// bdboard-ulxa.2: S2 (着地予定ツリーの verify で rebase を省く) の分岐と終了コードも同じ一時リポジトリで押さえる。
//
// 本物の GitHub・bd・main checkout には触れない。一時ディレクトリに bare の origin と、main
// checkout 役のクローン + そこから git worktree add した PR の worktree を作り、git は本物、gh / bd / npm は scripts/merge-pr/fake-tools.mjs
// (状態 JSON を読み書きする代役) で動かす。検証コマンドは偽の `node verify.cjs` で、
// どの SHA を検証したかをログに残す。Windows は統合部分を skip (bash 前提ではないが、
// 運用するのは macOS のエージェントだけで、always-on-server.test.mjs と同じ扱い)。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_HOT_FILES,
  decideS2Class,
  evaluateLandedStatus,
  globToRegExp,
  hotCollisions,
  hasApprovedReview,
  isReleasePleasePull,
  mergeCommand,
  parseGitHubSlug,
  parseMergeConfig,
  readMergeTree,
} from './merge-pr.mjs';

const SCRIPT = fileURLToPath(new URL('./merge-pr.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./merge-pr/fake-tools.mjs', import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(SCRIPT));
const CONTEXT = 'bdboard/landed-verify';
const PR = 7;
const TITLE = 'feat(demo-1): add the thing';

const VERIFY_JS = `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const head = execSync('git rev-parse HEAD').toString().trim();
fs.appendFileSync(process.env.FAKE_VERIFY_LOG, head + '\\n');
// SIGINT/SIGTERM のテスト用: 自分の (実際に検証を実行している) pid を書いておく。中断後に
// この pid が本当に死んでいるかで「子プロセスが孤児にならない」ことを確かめる。
if (process.env.FAKE_VERIFY_PID_FILE) fs.writeFileSync(process.env.FAKE_VERIFY_PID_FILE, String(process.pid));
// bdboard-ulxa.6: merge-pr が verify スロットに渡す優先度と並んだ時刻を記録する。
if (process.env.FAKE_VERIFY_ENV_LOG) fs.appendFileSync(process.env.FAKE_VERIFY_ENV_LOG, (process.env.BDBOARD_VERIFY_PRIORITY || '-') + ' ' + (process.env.BDBOARD_VERIFY_QUEUE_SINCE || '-') + '\\n');
// bdboard-e8o1: 孫プロセスの kill 確認用。設定されていれば、この検証プロセス自身の子として
// (detached せずに) 別の node プロセスを spawn する。同じプロセスグループに入るので、グループ
// 宛ての SIGTERM/SIGKILL は届くが、この孫は SIGTERM を無視する (見送り分 1 のポーリング確認:
// 直接の子 (このプロセス自身) は SIGTERM で即座に死ぬので、孫が SIGTERM を無視しないと
// 「直接の子の 'close' を見て後始末完了とみなす」旧実装でもたまたま道連れで死んでしまい、
// 新しいポーリング (SIGTERM で死ななければ猶予後に SIGKILL を送り直す) を検証できない)。
const grandchildPidFile = process.env.FAKE_VERIFY_GRANDCHILD_PID_FILE;
if (grandchildPidFile) {
  const { spawn } = require('node:child_process');
  const grandchildScript = "process.on('SIGTERM', () => {}); const fs=require('node:fs'); fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);";
  const grandchild = spawn(process.execPath, ['-e', grandchildScript], {
    stdio: 'ignore',
    env: { ...process.env, GRANDCHILD_PID_FILE: grandchildPidFile },
  });
  grandchild.unref();
}
// 意味的衝突の代役: 列挙したファイルが全部そろった木でだけ落ちる (片方だけなら緑)。
const conflict = process.env.FAKE_VERIFY_CONFLICT;
if (conflict && conflict.split(',').every((file) => fs.existsSync(file))) process.exit(3);
// verify の最中に main が動いたことの代役。
if (process.env.FAKE_VERIFY_MOVE_MAIN) execSync('git push -q origin ' + process.env.FAKE_VERIFY_MOVE_MAIN + ':refs/heads/main');
const sleepMs = Number(process.env.FAKE_VERIFY_SLEEP_MS || 0);
if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
process.exit(Number(process.env.FAKE_VERIFY_EXIT || 0));
`;

// bdboard-2twf: SIGINT テスト用の小さなヘルパー。pidAlive は finish.mjs の同名関数と同じ判定
// (EPERM = 居るが触れない = alive、ESRCH = もう居ない)。
function pidAlive(pid) {
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

async function waitUntil(predicate, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('merge-pr pure helpers', () => {
  const lease = 8 * 60_000;
  const now = Date.parse('2026-09-24T12:00:00Z');

  it('review helpers accept only Opus/Fable records and release-please branches', () => {
    expect(hasApprovedReview({ 'bdboard.model.review': 'opus-5' })).toBe(true);
    expect(hasApprovedReview({ 'bdboard.model.review': 'fable-chair-1' })).toBe(true);
    expect(hasApprovedReview({ 'bdboard.model.review': 'composer-2.5' })).toBe(false);
    expect(hasApprovedReview({})).toBe(false);
    expect(isReleasePleasePull({ headRef: 'release-please--branches--main' })).toBe(true);
    expect(isReleasePleasePull({ headRef: 'bd/demo-1' })).toBe(false);
  });

  it('evaluateLandedStatus: success / failure pass through, pending and missing wait until the lease runs out', () => {
    const commit = now - 60_000;
    const judge = (status, commitTimeMs = commit) => evaluateLandedStatus({ status, commitTimeMs, nowMs: now, leaseMs: lease });
    expect(judge({ state: 'success', updatedAt: commit })).toEqual({ verdict: 'success' });
    expect(judge({ state: 'failure', description: 'x', updatedAt: commit }).verdict).toBe('failure');
    expect(judge({ state: 'error', description: 'x', updatedAt: commit }).verdict).toBe('failure');
    expect(judge(null)).toEqual({ verdict: 'wait', remainingMs: lease - 60_000 });
    expect(judge(null, now - lease - 1).verdict).toBe('stale');
    // failure は LEASE を過ぎても自動では解除しない (明示的な修復が要る)。
    expect(judge({ state: 'failure', updatedAt: now - 10 * lease }, now - 10 * lease).verdict).toBe('failure');
    // pending は最後の更新 (自己修復が上書きした pending を含む) から数える。
    const old = now - 3 * lease;
    expect(judge({ state: 'pending', updatedAt: now - 1000 }, old).verdict).toBe('wait');
    expect(judge({ state: 'pending', updatedAt: old }, old).verdict).toBe('stale');
  });

  it('parseMergeConfig: defaults to S0 and rejects bad values', () => {
    const base = { version: 1, verify: 'npm run verify', prFlow: 'pr' };
    const parsed = parseMergeConfig(base);
    expect(parsed).toEqual({
      ok: true,
      config: {
        mode: 'S0',
        leaseMinutes: 8,
        slotWaitMinutes: 10,
        statusContext: CONTEXT,
        hotFiles: DEFAULT_HOT_FILES,
        verify: 'npm run verify',
        mainBranch: 'main',
        repo: null,
      },
    });
    expect(parseMergeConfig({ ...base, merge: { mode: 'S1', repo: 'o/r' } }).config).toMatchObject({ mode: 'S1', repo: 'o/r' });
    expect(parseMergeConfig({ ...base, merge: { mode: 'S2' } }).config.mode).toBe('S2');
    expect(parseMergeConfig({ ...base, merge: { mode: 'S3' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { hotFiles: ['a/**', '{b,c}.json'] } }).config.hotFiles).toEqual(['a/**', '{b,c}.json']);
    expect(parseMergeConfig({ ...base, merge: { hotFiles: [] } }).config.hotFiles).toEqual([]);
    expect(parseMergeConfig({ ...base, merge: { hotFiles: 'package.json' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { hotFiles: ['{a,b'] } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { hotFiles: [''] } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { leaseMinutes: 0 } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { statusContext: 'has space' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: { repo: 'no-slash' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, merge: [] }).ok).toBe(false);
    expect(parseMergeConfig({ ...base, verify: '' }).ok).toBe(false);
  });

  it("this repo's own contract has a valid merge block (the S0/S1/S2 switch is one line)", () => {
    const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, '.claude', 'bdboard-harness.json'), 'utf8'));
    const parsed = parseMergeConfig(contract);
    expect(parsed.ok).toBe(true);
    expect(['S0', 'S1', 'S2']).toContain(parsed.config.mode);
    expect(parsed.config.hotFiles.some((pattern) => globToRegExp(pattern).test('package-lock.json'))).toBe(true);
    expect(parsed.config.statusContext).toBe(CONTEXT);
    expect(contract.merge.leaseMinutes).toBe(8);
  });

  it('parseGitHubSlug handles https / ssh remotes and rejects others', () => {
    expect(parseGitHubSlug('https://github.com/xiaotiantakumi/bdboard.git')).toBe('xiaotiantakumi/bdboard');
    expect(parseGitHubSlug('git@github.com:xiaotiantakumi/bdboard.git\n')).toBe('xiaotiantakumi/bdboard');
    expect(parseGitHubSlug('https://github.com/o/r')).toBe('o/r');
    expect(parseGitHubSlug('/tmp/origin.git')).toBeNull();
  });

  it('mergeCommand prints a single shell-safe line with --match-head-commit and the (#n) subject', () => {
    expect(mergeCommand(12, 'abc123', 'fix(x-1): a b')).toBe(
      "gh pr merge 12 --squash --delete-branch --match-head-commit abc123 --subject 'fix(x-1): a b (#12)'",
    );
    expect(mergeCommand(4, 'b0b', 'fix(z): multi\nline  title\n')).toBe(
      "gh pr merge 4 --squash --delete-branch --match-head-commit b0b --subject 'fix(z): multi line title (#4)'",
    );
    expect(mergeCommand(3, 'f00', "docs(y): it's $HOME `x`")).toBe(
      "gh pr merge 3 --squash --delete-branch --match-head-commit f00 --subject 'docs(y): it'\\''s $HOME `x` (#3)'",
    );
  });

  it('globToRegExp: * stays inside a directory, ** crosses them, {a,b} alternates, and bad braces throw', () => {
    const match = (glob, file) => globToRegExp(glob).test(file);
    expect(match('package*.json', 'package-lock.json')).toBe(true);
    expect(match('package*.json', 'web/package.json')).toBe(false);
    expect(match('.github/workflows/**', '.github/workflows/ci.yml')).toBe(true);
    expect(match('.github/workflows/**', '.github/dependabot.yml')).toBe(false);
    expect(match('**/tsconfig.json', 'tsconfig.json')).toBe(true);
    expect(match('**/tsconfig.json', 'web/tsconfig.json')).toBe(true);
    expect(match('{a,b/c}.txt', 'b/c.txt')).toBe(true);
    expect(match('{a,b/c}.txt', 'axtxt')).toBe(false); // . は文字どおり
    expect(match('file?.md', 'file1.md')).toBe(true);
    expect(() => globToRegExp('{a,b')).toThrow();
    expect(() => globToRegExp('a}')).toThrow();
    expect(() => globToRegExp('{a,{b}}')).toThrow();
    expect(() => globToRegExp('')).toThrow();
  });

  it('hotCollisions: the same hot kind on both sides (not only the same file) collides; one side alone does not', () => {
    expect(hotCollisions(['web/package-lock.json'], ['package.json'], DEFAULT_HOT_FILES)).toEqual([
      { pattern: DEFAULT_HOT_FILES[0], main: ['web/package-lock.json'], mine: ['package.json'] },
    ]);
    expect(hotCollisions(['.github/workflows/ci.yml'], ['src/a.ts'], DEFAULT_HOT_FILES)).toEqual([]);
    expect(hotCollisions(['src/a.ts'], ['tsconfig.json'], DEFAULT_HOT_FILES)).toEqual([]);
    // eslint.config.mjs / file-size-baseline.json は hot ではない (設計 §6 裁定 3)。
    expect(hotCollisions(['eslint.config.mjs', 'scripts/file-size-baseline.json'], ['eslint.config.mjs', 'scripts/file-size-baseline.json'], DEFAULT_HOT_FILES)).toEqual([]);
    expect(hotCollisions(['.claude/skills/bdboard-harness/SKILL.md'], ['harness/packs/bdboard-harness/SKILL.md'], DEFAULT_HOT_FILES)).toHaveLength(1);
    // 検証系: 入れ子の tsconfig・verify スクリプト群・契約 (verify コマンドを持つ) は同じ種類。
    expect(hotCollisions(['test/e2e/tsconfig.json'], ['scripts/verify-slot.mjs'], DEFAULT_HOT_FILES)).toHaveLength(1);
    expect(hotCollisions(['.claude/bdboard-harness.json'], ['web/tsconfig.app.json'], DEFAULT_HOT_FILES)).toHaveLength(1);
    expect(hotCollisions(['scripts/other.mjs'], ['scripts/verify.mjs'], DEFAULT_HOT_FILES)).toEqual([]);
  });

  it('readMergeTree: exit 0 + OID is clean, exit 1 + OID is a conflict with its files, anything else is unavailable', () => {
    const oid = 'a'.repeat(40);
    expect(readMergeTree({ status: 0, stdout: `${oid}\n`, stderr: '' })).toEqual({ status: 'clean', tree: oid });
    expect(readMergeTree({ status: 1, stdout: `${oid}\nsrc/a.ts\n\nAuto-merging src/a.ts\nCONFLICT (content): x\n`, stderr: '' })).toEqual({
      status: 'conflict',
      files: ['src/a.ts'],
    });
    // exit 0 でも OID が読めなければ木を信用しない。exit 128 等は実行できない扱い (呼び出し側は R)。
    expect(readMergeTree({ status: 0, stdout: 'garbage\n', stderr: '' }).status).toBe('unavailable');
    expect(readMergeTree({ status: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' })).toEqual({
      status: 'unavailable',
      reason: 'fatal: refusing to merge unrelated histories',
    });
    expect(readMergeTree({ status: 1, stdout: '', stderr: '' }).status).toBe('unavailable');
  });

  it('decideS2Class: R for anything but one merge-base, a clean merge-tree and no hot collision; otherwise F with the tree', () => {
    const tree = 'b'.repeat(40);
    const clean = { status: 'clean', tree };
    expect(decideS2Class({ baseCount: 1, merge: clean, hot: [] })).toEqual({ class: 'F', reason: '衝突なし・hot file なし', tree });
    expect(decideS2Class({ baseCount: 2, merge: clean, hot: [] })).toMatchObject({ class: 'R', reason: expect.stringContaining('criss-cross') });
    expect(decideS2Class({ baseCount: 0, merge: null, hot: [] }).class).toBe('R');
    expect(decideS2Class({ baseCount: 1, merge: { status: 'conflict', files: ['x.ts'] }, hot: [] }).reason).toBe('テキスト衝突: x.ts');
    expect(decideS2Class({ baseCount: 1, merge: { status: 'unavailable', reason: 'boom' }, hot: [] }).class).toBe('R');
    const hot = [{ pattern: 'p', main: ['package-lock.json'], mine: ['package.json'] }];
    expect(decideS2Class({ baseCount: 1, merge: clean, hot })).toEqual({ class: 'R', reason: 'hot file: main package-lock.json / 自分 package.json' });
  });
});

describe('hasApprovedReview spelling variants', () => {
  const has = (value) => hasApprovedReview({ 'bdboard.model.review': value });
  it('accepts supported model spellings and rejects near matches and non-strings', () => {
    for (const value of ['claude-opus-5', 'claude-opus-5-5', 'claude:opus', 'Opus 5.5', 'fable-5.1']) {
      expect(has(value)).toBe(true);
    }
    for (const value of ['opusx-fake', 'fabled-sonnet', 'sonnet-5', 42, null, undefined, [], {}]) {
      expect(has(value)).toBe(false);
    }
    expect(hasApprovedReview({})).toBe(false);
  });
});

// 1 テストで node / git を十数回起こす。verify の並列実行中でも既定 5 秒で落ちないよう余裕を取る。
describe.skipIf(process.platform === 'win32')('merge-pr phases against a temp repo + fake gh/bd/npm', { timeout: 30_000 }, () => {
  let tmp;
  let mainCheckout;
  let work;
  let fakeState;
  let env;
  let base;
  let head;

  function git(cwd, args, extraEnv = {}) {
    const result = spawnSync('git', args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  const readFake = () => JSON.parse(readFileSync(fakeState, 'utf8'));
  const writeFake = (patch) => writeFileSync(fakeState, JSON.stringify({ ...readFake(), ...patch }, null, 2));
  const calls = (tool, sub) => readFake().calls.filter((call) => call[0] === tool && (sub === undefined || call.includes(sub)));
  const posted = () => readFake().posted ?? [];
  const verified = () => (existsSync(env.FAKE_VERIFY_LOG) ? readFileSync(env.FAKE_VERIFY_LOG, 'utf8').trim().split('\n') : []);
  const auditText = () => (existsSync(env.BDBOARD_MERGE_AUDIT_LOG) ? readFileSync(env.BDBOARD_MERGE_AUDIT_LOG, 'utf8') : '');
  // 状態は git common dir (= main checkout の .git) に置かれ、全 worktree から見える。
  const stateFile = () => path.join(mainCheckout, '.git', 'bdboard-merge', `pr-${PR}.json`);
  const status = (state, updatedAt = new Date().toISOString()) => ({ state, context: CONTEXT, description: state, updated_at: updatedAt });

  function run(args, extraEnv = {}, cwd = work) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function commitAll(cwd, message, extraEnv = {}) {
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', message], extraEnv);
    return git(cwd, ['rev-parse', 'HEAD']);
  }

  /**
   * origin (bare)・main checkout 役の mainCheckout・そこから git worktree add した PR worktree の
   * work を作る。main の先頭 (= PRED_BASE) は mainDate の時刻。work は bd/demo-1
   * (feature.txt を足した 1 コミット) を checkout した状態で返す。
   */
  function setup({ merge = {}, mainDate, branchFiles = {} } = {}) {
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
          [PR]: { number: PR, state: 'open', merged: false, merge_commit_sha: null, title: TITLE, draft: false, head: { sha: head, ref: 'bd/demo-1' }, base: { ref: 'main' } },
        },
        statuses: { [base]: [status('success')] },
        bdShow: { 'demo-1': [{ metadata: { 'bdboard.model.review': 'opus-5' } }] },
        slot: { holder: null },
        calls: [],
      }),
    );
  }

  /** gh pr merge の代わりに squash マージを origin に着地させ、PR をマージ済みにする。 */
  function simulateMerge() {
    const tree = git(work, ['rev-parse', 'HEAD^{tree}']);
    const landed = git(work, ['commit-tree', tree, '-p', base, '-m', `${TITLE} (#${PR})`]);
    git(work, ['push', '-q', 'origin', `${landed}:refs/heads/main`]);
    const fake = readFake();
    fake.pulls[PR] = { ...fake.pulls[PR], state: 'closed', merged: true, merge_commit_sha: landed };
    writeFileSync(fakeState, JSON.stringify(fake));
    return landed;
  }

  /** main を base から 1 コミット進めた commit を作る (push はしない)。 */
  function peerCommit() {
    return git(work, ['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'feat(peer): landed meanwhile']);
  }

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    tmp = undefined;
  });

  beforeEach(() => {
    tmp = undefined;
  });

  it('rejects usage errors before touching git', () => {
    setup();
    expect(run(['--help']).status).toBe(0);
    expect(run([]).status).toBe(1);
    expect(run(['bogus', '7']).status).toBe(1);
    expect(run(['gate', 'x']).status).toBe(1);
    expect(run(['prepare', '7', '--force']).status).toBe(1);
    expect(readFake().calls).toEqual([]);
  });

  it("prepare: refuses when its own tooling (scripts/merge-pr) is stale vs origin/main", () => {
    setup();
    mkdirSync(path.join(mainCheckout, 'scripts'), { recursive: true });
    writeFileSync(path.join(mainCheckout, 'scripts', 'merge-pr.mjs'), '// pretend main moved this tool\n');
    commitAll(mainCheckout, 'chore: touch merge-pr tool');
    git(mainCheckout, ['push', '-q', 'origin', 'main']);
    const result = run(['prepare', String(PR)]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('scripts/merge-pr');
    expect(calls('gh')).toEqual([]);
    expect(calls('bd')).toEqual([]);
  });

  it('prepare: a PR that only changes scripts/merge-pr itself does not trip the staleness check', () => {
    setup({ branchFiles: { 'scripts/merge-pr/whatever.mjs': '// pr-only change\n' } });
    const result = run(['prepare', String(PR)]);
    expect(result.status).not.toBe(3);
    expect(result.stderr).toContain('クラス=N');
    expect(result.stderr).not.toContain('scripts/merge-pr');
  });

  it('prepare: main changing scripts/merge-pr after the branch point still trips the check', () => {
    setup();
    mkdirSync(path.join(mainCheckout, 'scripts', 'merge-pr'), { recursive: true });
    writeFileSync(path.join(mainCheckout, 'scripts', 'merge-pr', 'foo.mjs'), '// main moved this tool\n');
    commitAll(mainCheckout, 'chore: touch merge-pr directory');
    git(mainCheckout, ['push', '-q', 'origin', 'main']);
    const result = run(['prepare', String(PR)]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('git merge');
    expect(result.stderr).toContain('取り込んで');
  });

  it('S0: prepare only reports the class and gate / finish refuse to run', () => {
    setup({ merge: { mode: 'S0' } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('クラス=N');
    expect(prepared.stderr).toContain('merge.mode は S0');
    expect(existsSync(stateFile())).toBe(false);
    expect(run(['gate', String(PR)]).status).toBe(2);
    expect(run(['finish', String(PR)]).status).toBe(2);
    expect(calls('bd').filter((c) => c[1] !== 'show')).toEqual([]);
  });

  it('prepare: requires an Opus/Fable review record and a ticket branch, except release-please', () => {
    setup();
    writeFake({ bdShow: { 'demo-1': [{ metadata: {} }] } });
    const missing = run(['prepare', String(PR)]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('レビュー記録がありません: bd update demo-1 --set-metadata bdboard.model.review=<model>');
    expect(missing.stderr).toContain('現在の値: なし');

    setup();
    writeFake({ bdShow: { 'demo-1': [] } });
    expect(run(['prepare', String(PR)]).stderr).toContain('現在の値: なし');

    setup();
    writeFake({ bdShow: { 'demo-1': [{ metadata: null }] } });
    expect(run(['prepare', String(PR)]).stderr).toContain('現在の値: なし');

    setup();
    writeFake({ bdShow: { 'demo-1': 'not-found' } });
    const notFound = run(['prepare', String(PR)]);
    expect(notFound.status).toBe(2);
    expect(notFound.stderr.trim()).toBe('merge-pr: チケット demo-1 が bd にありません');

    setup();
    writeFake({ bdShow: { 'demo-1': 'unreachable' } });
    const unreachable = run(['prepare', String(PR)]);
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toContain('dolt server unreachable');

    setup();
    writeFake({ bdShow: { 'demo-1': 'bad-json' } });
    expect(run(['prepare', String(PR)]).status).toBe(1);

    setup();
    expect(run(['prepare', String(PR), '--dry-run']).status).toBe(0);
    writeFake({ bdShow: { 'demo-1': [{ metadata: {} }] } });
    expect(run(['prepare', String(PR), '--dry-run']).status).toBe(2);

    setup();
    const child = readFake();
    child.pulls[PR].head.ref = 'bd/demo-1.2';
    child.bdShow['demo-1.2'] = [{ metadata: { 'bdboard.model.review': 'opus-5' } }];
    writeFileSync(fakeState, JSON.stringify(child));
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(calls('bd', 'show').some((call) => call.includes('demo-1.2'))).toBe(true);

    setup();
    expect(run(['prepare', String(PR)], { BDBOARD_MERGER: '' }).status).toBe(0);

    setup();
    const fake = readFake();
    fake.pulls[PR].head.ref = 'spike/no-ticket';
    writeFileSync(fakeState, JSON.stringify(fake));
    const noTicket = run(['prepare', String(PR)]);
    expect(noTicket.status).toBe(2);
    expect(noTicket.stderr).toContain('チケット ID がありません');

    setup();
    const release = readFake();
    release.pulls[PR].head.ref = 'release-please--branches--main';
    writeFileSync(fakeState, JSON.stringify(release));
    expect(run(['prepare', String(PR), '--dry-run']).status).toBe(0);
    expect(calls('bd', 'show')).toEqual([]);
    run(['prepare', String(PR)]);
    expect(calls('bd', 'show')).toEqual([]);
  });

  it('gate and finish require BDBOARD_MERGER=chair, including gate --repair', () => {
    setup();
    for (const args of [
      ['gate', String(PR)],
      ['gate', String(PR), '--repair'],
      ['finish', String(PR)],
      ['verify', '0123456789abcdef'],
    ]) {
      const result = run(args, { BDBOARD_MERGER: '' });
      expect(result.status).toBe(7);
      expect(result.stderr).toContain('gate / finish は議長だけが行います。BDBOARD_MERGER=chair を前置してください。');
    }
    expect(run(['gate', String(PR)], { BDBOARD_MERGER: 'Chair' }).status).toBe(7);
    expect(readFake().calls).toEqual([]);
  });

  it('prepare: class R when main moved past the PR base (rebase outside the slot)', () => {
    setup();
    git(work, ['push', '-q', 'origin', `${peerCommit()}:refs/heads/main`]);
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('クラス=R');
    expect(prepared.stderr).toContain('git rebase origin/main');
    expect(existsSync(stateFile())).toBe(false);
    expect(calls('gh', 'checks')).toEqual([]);
  });

  it('prepare: refuses a HEAD that is not the PR head, pending CI (75) and red CI (2)', () => {
    setup();
    const fake = readFake();
    fake.pulls[PR].head.sha = base;
    writeFileSync(fakeState, JSON.stringify(fake));
    expect(run(['prepare', String(PR)]).status).toBe(2);
    fake.pulls[PR].head.sha = head;
    writeFileSync(fakeState, JSON.stringify(fake));
    writeFake({ checks: { [PR]: 8 } });
    expect(run(['prepare', String(PR)]).status).toBe(75);
    writeFake({ checks: { [PR]: 1 } });
    expect(run(['prepare', String(PR)]).status).toBe(2);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('happy path: slot is held only from gate to finish, and the landed tree is verified and recorded', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toMatchObject({ pr: PR, id: 'demo-1', head, predBase: base, class: 'N' });

    const gated = run(['gate', String(PR)]);
    expect(gated.stderr).not.toContain('想定外');
    expect(gated.status).toBe(0);
    expect(gated.stdout).toBe(`gh pr merge ${PR} --squash --delete-branch --match-head-commit ${head} --subject '${TITLE} (#${PR})'\n`);
    expect(readFake().slot.holder).toBe(`demo-1 / PR#${PR}`);
    expect(run(['gate', String(PR)]).status).toBe(2); // 二重 gate しない

    const landed = simulateMerge();
    const finished = run(['finish', String(PR)]);
    expect(finished.stderr).toContain('着地後検証 success');
    expect(finished.stderr).toContain('同一');
    expect(finished.status).toBe(0);
    expect(readFake().slot.holder).toBeNull();
    expect(posted().map(({ sha, state, context }) => [sha, state, context])).toEqual([
      [landed, 'pending', CONTEXT],
      [landed, 'success', CONTEXT],
    ]);
    expect(verified()).toEqual([landed]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(existsSync(stateFile())).toBe(false);
    const audit = auditText();
    for (const event of ['\tprepare\t', '\tgate-acquired\t', '\tfinish-released\t', '\tlanded-verify\t']) {
      expect(audit).toContain(event);
    }
    expect(audit).toMatch(/finish-released\tpr=7\tid=demo-1\theld_s=\d+/);
    expect(audit).toMatch(/finish-merged\tpr=7\tid=demo-1\tmerged=true\tnew=[0-9a-f]{40}/);
    expect(run(['finish', String(PR)]).status).toBe(2);
  });

  it('gate: CAS lost after acquire releases the slot and sends the agent back to prepare', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ slot: { holder: null, onAcquire: ['git', '-C', work, 'push', '-q', 'origin', `${peerCommit()}:refs/heads/main`] } });
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(75);
    expect(gated.stdout).toBe('');
    expect(gated.stderr).toContain('CAS 負け');
    expect(readFake().slot.holder).toBeNull();
    expect(calls('bd', 'release')).toEqual([['bd', 'merge-slot', 'release', '--holder', `demo-1 / PR#${PR}`]]);
    expect(existsSync(stateFile())).toBe(false);
    expect(auditText()).toContain('\tgate-cas-lost\t');
  });

  it('gate: main moving or the PR head changing after prepare means start over without taking the slot', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    git(work, ['push', '-q', 'origin', `${peerCommit()}:refs/heads/main`]);
    expect(run(['gate', String(PR)]).status).toBe(75);
    expect(calls('bd', 'acquire')).toEqual([]);

    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const fake = readFake();
    fake.pulls[PR].head.sha = base;
    writeFileSync(fakeState, JSON.stringify(fake));
    expect(run(['gate', String(PR)]).status).toBe(75);
    expect(calls('bd', 'acquire')).toEqual([]);
  });

  it('gate: waits while the previous landed-verify is pending within the lease', () => {
    setup();
    writeFake({ statuses: {}, statusQueue: { [base]: [[status('pending')], [status('pending')], [status('success')]] } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(0);
    expect(gated.stderr).toContain('着地後検証を待っています');
    expect(calls('gh').filter((call) => call.some((arg) => arg.endsWith(`/commits/${base}/status`))).length).toBe(3);
    expect(verified()).toEqual([]);
  });

  it('gate: a failed landed-verify on main blocks the merge without taking the slot', () => {
    setup();
    writeFake({ statuses: { [base]: [status('failure')] } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(4);
    expect(gated.stderr).toContain('bd create --type bug -p 0');
    expect(calls('bd', 'acquire')).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it.each([
    ['no status at all', []],
    ['a pending status nobody finished', [status('pending', '2026-01-01T00:00:00Z')]],
  ])('gate: self-heals when the lease has run out (%s)', (_label, statuses) => {
    setup({ mainDate: '2026-01-01T00:00:00Z' });
    writeFake({ statuses: { [base]: statuses } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.stderr).toContain('自己修復');
    expect(gated.status).toBe(0);
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [base, 'pending'],
      [base, 'success'],
    ]);
    expect(verified()).toEqual([base]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(auditText()).toContain('\tgate-self-heal\t');
  });

  it('gate: a failing self-heal records failure and blocks the merge', () => {
    setup({ mainDate: '2026-01-01T00:00:00Z' });
    writeFake({ statuses: {} });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(gated.status).toBe(4);
    expect(posted().map(({ state }) => state)).toEqual(['pending', 'failure']);
    expect(calls('bd', 'acquire')).toEqual([]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  it("gate: waits for someone else's slot, never releases it, and gives up after slotWaitMinutes", () => {
    setup();
    writeFake({ slot: { holder: 'other-1 / PR#1', freeAfter: 2 } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    expect(calls('bd', 'acquire').length).toBe(3);
    expect(calls('bd', 'release')).toEqual([]);

    setup({ merge: { slotWaitMinutes: 0.003 } });
    writeFake({ slot: { holder: 'other-1 / PR#1' } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(75);
    expect(gated.stderr).toContain('他人の枠は release しません');
    expect(calls('bd', 'release')).toEqual([]);
    expect(readFake().slot.holder).toBe('other-1 / PR#1');
    expect(auditText()).toContain('\tgate-slot-timeout\t');
  });

  it('gate: takes over a slot this same PR already holds (an interrupted earlier gate)', () => {
    setup();
    writeFake({ slot: { holder: `demo-1 / PR#${PR}` } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    expect(calls('bd', 'acquire')).toEqual([]);
  });

  it('finish: an unmerged PR (merge refused / 409) just returns the slot', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(5);
    expect(finished.stderr).toContain('マージされていません');
    expect(readFake().slot.holder).toBeNull();
    expect(posted()).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('finish: a failing landed-verify records failure and holds the slot for the repair (§3.6)', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(finished.status).toBe(6);
    expect(finished.stderr).toContain('revert');
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'failure'],
    ]);
    expect(readFake().slot.holder).toBe(`demo-1 / main-broken ${landed.slice(0, 12)}`);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  it('finish: refuses to start while the working tree is dirty and leaves the ledger pending-free', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    writeFileSync(path.join(work, 'feature.txt'), 'uncommitted\n');
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain('npm run merge-pr -- verify');
    expect(readFake().slot.holder).toBeNull();
    expect(posted()).toEqual([]);
  });

  it('npm ci runs only when the lockfile differs from what the worktree last installed', () => {
    setup({ mainDate: '2026-01-01T00:00:00Z', branchFiles: { 'package-lock.json': '{"lockfileVersion":3}\n' } });
    writeFake({ statuses: {} });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    // 自己修復: 入っているのはブランチの lockfile、検証するのは lockfile の無い main → npm ci
    expect(run(['gate', String(PR)]).status).toBe(0);
    expect(calls('npm')).toEqual([['npm', 'ci']]);
    simulateMerge();
    // finish: 入っているのは main の依存、着地した木はブランチの lockfile → もう一度 npm ci
    expect(run(['finish', String(PR)]).status).toBe(0);
    expect(calls('npm')).toEqual([['npm', 'ci'], ['npm', 'ci']]);
  });

  it('finish / verify refuse to detach the main checkout; only a linked PR worktree runs the landed verify', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], {}, mainCheckout);
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain('PR の worktree');
    expect(readFake().slot.holder).toBeNull(); // 枠は検証より先に返している
    expect(posted()).toEqual([]);
    expect(verified()).toEqual([]);
    expect(git(mainCheckout, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(run(['verify', landed], {}, mainCheckout).status).toBe(1);
    expect(posted()).toEqual([]);
    // PR の worktree からなら手で検証して台帳に書ける。
    expect(run(['verify', landed]).status).toBe(0);
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'success'],
    ]);
  });

  it('gate --repair: the fix PR for a broken main takes over the main-broken slot and returns it only after success', () => {
    setup();
    const brokenHolder = `demo-0 / main-broken ${base.slice(0, 12)}`;
    writeFake({ statuses: { [base]: [status('failure')] }, slot: { holder: brokenHolder } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(4);
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR), '--repair']);
    expect(gated.status).toBe(0);
    expect(gated.stdout).toBe(`gh pr merge ${PR} --squash --delete-branch --match-head-commit ${head} --subject '${TITLE} (#${PR})'\n`);
    expect(calls('bd', 'acquire')).toEqual([]);
    expect(readFake().slot.holder).toBe(brokenHolder);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(0);
    expect(finished.stderr).toContain('main が緑に戻った');
    expect(readFake().slot.holder).toBeNull();
    expect(calls('bd', 'release')).toEqual([['bd', 'merge-slot', 'release', '--holder', brokenHolder]]);
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'success'],
    ]);
    expect(auditText()).toContain('\trepair-released\t');
  });

  it('gate --repair: a refused or still-failing repair keeps holding the main-broken slot', () => {
    setup();
    writeFake({ statuses: { [base]: [status('failure')] } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR), '--repair']).status).toBe(0);
    const holder = `demo-1 / main-broken ${base.slice(0, 12)}`;
    expect(readFake().slot.holder).toBe(holder);
    const refused = run(['finish', String(PR)]);
    expect(refused.status).toBe(5);
    expect(refused.stderr).toContain('保持しています');
    expect(readFake().slot.holder).toBe(holder);
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR), '--repair']).status).toBe(0);
    simulateMerge();
    expect(run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' }).status).toBe(6);
    expect(readFake().slot.holder).toBe(holder);
    expect(calls('bd', 'release')).toEqual([]);
  });

  it('finish keeps the pending status fresh while verify runs, so other gates wait instead of self-healing', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], { BDBOARD_MERGE_HEARTBEAT_MS: '100', FAKE_VERIFY_SLEEP_MS: '1500' });
    expect(finished.status).toBe(0);
    const states = posted()
      .filter(({ sha }) => sha === landed)
      .map(({ state }) => state);
    expect(states[0]).toBe('pending');
    expect(states.at(-1)).toBe('success');
    expect(states.filter((state) => state === 'pending').length).toBeGreaterThanOrEqual(3);
  });

  it('gate: a broken bd fails fast instead of waiting out slotWaitMinutes', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ slot: { holder: null, broken: true } });
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(1);
    expect(gated.stderr).toContain('bd merge-slot を使えません');
    expect(gated.stdout).toBe('');
    expect(calls('bd', 'acquire')).toEqual([]);
  });

  it('prepare: a GitHub API error from gh pr checks is a retry (75), not red CI', () => {
    setup();
    writeFake({ checksError: { [PR]: 'GraphQL: API rate limit exceeded for user ID 1.' } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(75);
    expect(prepared.stderr).toContain('取得できませんでした');
    expect(existsSync(stateFile())).toBe(false);
  });

  it('gate: an unreadable remote after acquire returns the slot and is not reported as a CAS loss', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ slot: { holder: null, onAcquire: ['git', '-C', work, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git')] } });
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(75);
    expect(gated.stderr).toContain('ls-remote');
    expect(gated.stderr).not.toContain('CAS 負け');
    expect(gated.stdout).toBe('');
    expect(readFake().slot.holder).toBeNull();
  });

  it('self-heal: a failing npm ci is an error (exit 1) and writes nothing to the ledger', () => {
    setup({ mainDate: '2026-01-01T00:00:00Z', branchFiles: { 'package-lock.json': '{"lockfileVersion":3}\n' } });
    writeFake({ statuses: {}, npmExit: 1 });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(1);
    expect(gated.stderr).toContain('台帳には書きません');
    expect(posted()).toEqual([]);
    expect(calls('bd', 'acquire')).toEqual([]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  // ---- bdboard-ulxa.2: S2 (着地予定ツリーを手元で verify して rebase を省く) ----

  /** main checkout 役から origin/main を 1 コミット進める (files: パス → 内容)。 */
  function advanceMain(files) {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(mainCheckout, file)), { recursive: true });
      writeFileSync(path.join(mainCheckout, file), content);
    }
    const sha = commitAll(mainCheckout, 'feat(peer): landed meanwhile');
    git(mainCheckout, ['push', '-q', 'origin', 'main']);
    return sha;
  }

  /** GitHub の squash の代役: 今の remote main に head を 3-way マージした木 (または tree) を 1 親で着地させる。 */
  function landSquash(tree) {
    const parent = git(work, ['ls-remote', 'origin', 'refs/heads/main']).split('\t')[0];
    const landedTree = tree ?? git(work, ['merge-tree', '--write-tree', parent, head]);
    const landed = git(work, ['commit-tree', landedTree, '-p', parent, '-m', `${TITLE} (#${PR})`]);
    git(work, ['push', '-q', 'origin', `${landed}:refs/heads/main`]);
    const fake = readFake();
    fake.pulls[PR] = { ...fake.pulls[PR], state: 'closed', merged: true, merge_commit_sha: landed };
    writeFileSync(fakeState, JSON.stringify(fake));
    return landed;
  }

  const readState = () => JSON.parse(readFileSync(stateFile(), 'utf8'));

  it('S2 prepare: main not moved is class N exactly as in S1 (no predicted verify)', () => {
    setup({ merge: { mode: 'S2' } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('クラス=N');
    expect(readState()).toMatchObject({ class: 'N', predBase: base, head });
    expect(readState().predictedTree).toBeUndefined();
    expect(verified()).toEqual([]);
  });

  it('S2 happy path: main moved on other files → F; the predicted tree is verified outside the slot and is the tree that lands', () => {
    setup({ merge: { mode: 'S2' } });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.stderr).not.toContain('想定外');
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('クラス=F');
    const expectedTree = git(work, ['merge-tree', '--write-tree', moved, head]);
    const state = readState();
    expect(state).toMatchObject({ class: 'F', predBase: moved, head, predictedTree: expectedTree });
    expect(git(work, ['rev-parse', `${state.predictedCommit}^{tree}`])).toBe(expectedTree);
    expect(git(work, ['rev-list', '--parents', '-n', '1', state.predictedCommit]).split(' ').slice(1)).toEqual([moved, head]);
    expect(verified()).toEqual([state.predictedCommit]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(git(work, ['rev-parse', 'HEAD'])).toBe(head); // rebase も push もしていない
    expect(calls('bd').filter((c) => c[1] !== 'show')).toEqual([]); // prepare は枠に触れない
    expect(posted()).toEqual([]); // 着地予定コミットは GitHub に無いので台帳にも書かない
    expect(calls('gh', 'checks')).toHaveLength(1);
    expect(auditText()).toMatch(/\tpredicted-verify\t.*result=success/);

    writeFake({ statuses: { [moved]: [status('success')] } });
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(0);
    expect(gated.stdout).toBe(`gh pr merge ${PR} --squash --delete-branch --match-head-commit ${head} --subject '${TITLE} (#${PR})'\n`);
    const landed = landSquash();
    expect(git(work, ['rev-parse', `${landed}^{tree}`])).toBe(expectedTree);
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(0);
    expect(finished.stderr).toContain('着地予定ツリーと同一');
    expect(verified()).toEqual([state.predictedCommit, landed]);
    expect(posted().map(({ sha, state: s }) => [sha, s])).toEqual([
      [landed, 'pending'],
      [landed, 'success'],
    ]);
    expect(auditText()).toMatch(/\tpredicted-tree\tpr=7\tid=demo-1\tmatch=true/);
    expect(readFake().slot.holder).toBeNull();
    expect(existsSync(stateFile())).toBe(false);
  });

  it('S2 prepare: a text conflict with main is class R (exit 3); nothing is verified and CI is not asked', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'feature.txt': 'main side\n' });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('クラス=R');
    expect(prepared.stderr).toContain('テキスト衝突: feature.txt');
    expect(prepared.stderr).toContain('git rebase origin/main');
    expect(verified()).toEqual([]);
    expect(calls('gh', 'checks')).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('S2 prepare: the same hot kind on both sides is class R without a text conflict; a one-sided hot file is still F', () => {
    setup({ merge: { mode: 'S2' }, branchFiles: { 'package.json': '{"name":"demo"}\n' } });
    advanceMain({ 'package-lock.json': '{"lockfileVersion":3}\n' });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('hot file: main package-lock.json / 自分 package.json');
    expect(verified()).toEqual([]);

    setup({ merge: { mode: 'S2' } });
    advanceMain({ '.github/workflows/ci.yml': 'on: push\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(readState().class).toBe('F');
  });

  it('S2 prepare: merge.hotFiles in the contract replaces the default list', () => {
    setup({ merge: { mode: 'S2', hotFiles: ['{feature,peer}.txt'] } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('hot file: main peer.txt / 自分 feature.txt');
  });

  it('S2 prepare: a file-disjoint semantic conflict fails the predicted verify → exit 3, no state, no ledger, no slot', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const prepared = run(['prepare', String(PR)], { FAKE_VERIFY_CONFLICT: 'feature.txt,peer.txt' });
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('着地予定ツリー');
    expect(prepared.stderr).toContain('rebase に格下げ');
    expect(verified()).toHaveLength(1);
    expect(existsSync(stateFile())).toBe(false);
    expect(posted()).toEqual([]);
    expect(calls('bd').filter((c) => c[1] !== 'show')).toEqual([]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(auditText()).toMatch(/\tpredicted-verify\t.*result=failure/);
  });

  it('S2 prepare: main moving during the predicted verify is a retry (75) with no state left behind', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const later = git(mainCheckout, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'feat(peer2): landed during verify']);
    const prepared = run(['prepare', String(PR)], { FAKE_VERIFY_MOVE_MAIN: later });
    expect(prepared.status).toBe(75);
    expect(prepared.stderr).toContain('verify の間に');
    expect(existsSync(stateFile())).toBe(false);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  it('S2 prepare: main moving while the predicted verify is still running stops it right away (75, bdboard-ulxa.6)', async () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const pidFile = path.join(tmp, 'predicted-verify.pid');
    const child = spawn(process.execPath, [SCRIPT, 'prepare', String(PR)], {
      cwd: work,
      env: { ...env, FAKE_VERIFY_SLEEP_MS: '60000', FAKE_VERIFY_PID_FILE: pidFile, BDBOARD_MERGE_KILL_GRACE_MS: '200' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    let verifyPid;
    try {
      await waitUntil(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) > 0);
      verifyPid = Number(readFileSync(pidFile, 'utf8'));
      advanceMain({ 'peer2.txt': 'peer2\n' }); // 別 PR が着地した
      const started = Date.now();
      expect(await exited).toBe(75);
      expect(Date.now() - started).toBeLessThan(15_000); // 60 秒の verify を最後まで待たない
      await waitUntil(() => !pidAlive(verifyPid), { timeoutMs: 5_000 });
    } finally {
      child.kill('SIGKILL');
      if (verifyPid !== undefined && pidAlive(verifyPid)) {
        process.kill(verifyPid, 'SIGKILL');
      }
    }
    expect(stderr).toContain('途中でやめました');
    expect(stderr).toContain(`npm run merge-pr -- prepare ${PR}`);
    expect(existsSync(stateFile())).toBe(false);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(auditText()).toMatch(/\tpredicted-verify\t.*result=abandoned/);
  });

  it('S2: the predicted verify queues as merge with the time the PR first queued, kept across a 75 retry; finish verifies as landed and forgets it', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const envLog = path.join(tmp, 'verify-env.log');
    const queueFile = path.join(mainCheckout, '.git', 'bdboard-merge', `pr-${PR}-queue.json`);
    const later = git(mainCheckout, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'feat(peer2): landed during verify']);
    // bdboard-lmhs: 高負荷の verify で 2 回目の prepare が 75 を返したことがある (原因未特定)。
    // 次に落ちたとき原因が分かるよう、終了コードの不一致には merge-pr の出力と監査ログを添える。
    const expectExit = (result, code) =>
      expect(result.status, `merge-pr exited ${result.status}:\n${result.stderr}\naudit:\n${auditText()}`).toBe(code);
    expectExit(run(['prepare', String(PR)], { FAKE_VERIFY_ENV_LOG: envLog, FAKE_VERIFY_MOVE_MAIN: later }), 75);
    const { since } = JSON.parse(readFileSync(queueFile, 'utf8'));
    expectExit(run(['prepare', String(PR)], { FAKE_VERIFY_ENV_LOG: envLog }), 0);
    writeFake({ statuses: { [later]: [status('success')] } });
    expectExit(run(['gate', String(PR)]), 0);
    landSquash();
    expectExit(run(['finish', String(PR)], { FAKE_VERIFY_ENV_LOG: envLog }), 0);
    expect(readFileSync(envLog, 'utf8').trim().split('\n')).toEqual([`merge ${since}`, `merge ${since}`, 'landed -']);
    expect(existsSync(queueFile)).toBe(false);
  });

  it('S2 prepare: a dirty worktree cannot verify the predicted tree (exit 1) and a stale record from an earlier prepare is dropped', () => {
    setup({ merge: { mode: 'S2' } });
    expect(run(['prepare', String(PR)]).status).toBe(0); // 前回の prepare (クラス N) の記録
    advanceMain({ 'peer.txt': 'peer\n' });
    writeFileSync(path.join(work, 'feature.txt'), 'uncommitted\n');
    expect(run(['prepare', String(PR)]).status).toBe(1);
    expect(existsSync(stateFile())).toBe(false);
    expect(verified()).toEqual([]);
  });

  it('S2 finish: a landed tree that differs from the predicted one is reported; the landed verify still decides', () => {
    setup({ merge: { mode: 'S2' } });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ statuses: { [moved]: [status('success')] } });
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = landSquash(git(work, ['rev-parse', `${head}^{tree}`]));
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(0);
    expect(finished.stderr).toContain('着地予定ツリー');
    expect(finished.stderr).toContain('違います');
    expect(auditText()).toMatch(/\tpredicted-tree\tpr=7\tid=demo-1\tmatch=false/);
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'success'],
    ]);
  });

  it('gate: a class-F record is sent back to prepare under S1 (rolled back) or when the predicted verify is not recorded', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), class: 'F', predictedTree: 'c'.repeat(40), predictedVerifiedAt: 'x' }));
    const rolledBack = run(['gate', String(PR)]);
    expect(rolledBack.status).toBe(75);
    expect(rolledBack.stderr).toContain('クラス F');
    expect(existsSync(stateFile())).toBe(false);

    setup({ merge: { mode: 'S2' } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), class: 'F' }));
    expect(run(['gate', String(PR)]).status).toBe(75);
    expect(calls('bd', 'acquire')).toEqual([]);
  });

  it('prepare refuses while this PR is gated and holds the slot (finish first); the record survives for finish', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const again = run(['prepare', String(PR), '--dry-run']);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('finish');
    expect(readState().gateAt).toBeTruthy();
    expect(run(['finish', String(PR)]).status).toBe(5);
    expect(readFake().slot.holder).toBeNull();
  });

  it("S2 prepare: the predicted tree ignores the merger's rename config (merge.renames=false in ~/.gitconfig)", () => {
    setup({ merge: { mode: 'S2' }, branchFiles: { 'README.md': 'demo\nfrom the PR\n' } });
    git(mainCheckout, ['mv', 'README.md', 'DOC.md']);
    const moved = commitAll(mainCheckout, 'docs(peer): rename README');
    git(mainCheckout, ['push', '-q', 'origin', 'main']);
    // 既定の改名検出なら「改名 + 変更」で綺麗に混ざる。利用者設定のまま走ると modify/delete の衝突になる。
    writeFileSync(path.join(env.HOME, '.gitconfig'), '[merge]\n\trenames = false\n');
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    const expectedTree = git(work, ['-c', 'merge.renames=true', 'merge-tree', '--write-tree', moved, head]);
    expect(readState()).toMatchObject({ class: 'F', predictedTree: expectedTree });
    expect(git(work, ['show', `${expectedTree}:DOC.md`])).toBe('demo\nfrom the PR');
  });

  it('S2 prepare: GitHub saying mergeable=false demotes F to R (gh pr merge would fail with 405)', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const fake = readFake();
    writeFake({ pulls: { ...fake.pulls, [PR]: { ...fake.pulls[PR], mergeable: false } } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('mergeable=false');
    expect(verified()).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('S2 prepare: a failed ledger on PRED_BASE is a broken main (exit 4) before any predicted verify', () => {
    setup({ merge: { mode: 'S2' } });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    writeFake({ statuses: { [moved]: [status('failure')] } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(4);
    expect(prepared.stderr).toContain('bd create --type bug -p 0');
    expect(prepared.stderr).toContain('gate --repair');
    expect(verified()).toEqual([]);
    expect(calls('bd').filter((c) => c[1] !== 'show')).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('prepare --dry-run previews the S2 class in any mode and never verifies or writes state', () => {
    setup();
    advanceMain({ 'peer.txt': 'peer\n' });
    const s1 = run(['prepare', String(PR), '--dry-run']);
    expect(s1.status).toBe(3); // S1 では main が動いたら R のまま
    expect(s1.stderr).toContain('参考: merge.mode が S2 ならクラス=F');

    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const s2 = run(['prepare', String(PR), '--dry-run']);
    expect(s2.status).toBe(0);
    expect(s2.stderr).toContain('クラス=F');
    expect(s2.stderr).toContain('verify もしません');
    expect(verified()).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('prepare: a HEAD left detached (an interrupted verify) is refused with the way back', () => {
    setup({ merge: { mode: 'S2' } });
    git(work, ['checkout', '-q', '--detach', base]);
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(2);
    expect(prepared.stderr).toContain('git checkout bd/demo-1');
  });

  it('finish: refuses while the worktree has an untracked, non-ignored file (gitignored ones do not block)', () => {
    setup({ branchFiles: { '.gitignore': 'ignored.log\n' } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    writeFileSync(path.join(work, 'ignored.log'), 'noise\n');
    writeFileSync(path.join(work, 'stray.ts'), 'export const x = 1;\n');
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain('未追跡ファイル');
    expect(finished.stderr).toContain('stray.ts');
    expect(finished.stderr).not.toContain('ignored.log');
    expect(readFake().slot.holder).toBeNull(); // 枠は検証より先に返している
    expect(posted()).toEqual([]);
    expect(verified()).toEqual([]);
    expect(existsSync(stateFile())).toBe(true); // 記録は残る (finish をやり直せる)

    rmSync(path.join(work, 'stray.ts'));
    const retried = run(['finish', String(PR)]);
    expect(retried.status).toBe(0);
    expect(verified()).toEqual([landed]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('finish: SIGINT during the landed verify kills the verify process and restores the branch instead of leaving an orphan / detached HEAD', async () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const pidFile = path.join(tmp, 'verify.pid');
    const child = spawn(process.execPath, [SCRIPT, 'finish', String(PR)], {
      cwd: work,
      env: { ...env, FAKE_VERIFY_SLEEP_MS: '60000', FAKE_VERIFY_PID_FILE: pidFile, BDBOARD_MERGE_KILL_GRACE_MS: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    let verifyPid;
    try {
      // fake verify がまだ書き込み中の pid ファイルを読まないよう、パース結果が正の整数に
      // なるまで待つ (存在するだけでは不十分 — 書き込み途中の空/部分文字列を拾いうる)。
      await waitUntil(() => {
        if (!existsSync(pidFile)) {
          return false;
        }
        const parsed = Number(readFileSync(pidFile, 'utf8').trim());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return false;
        }
        verifyPid = parsed;
        return true;
      });
      expect(pidAlive(verifyPid)).toBe(true);

      child.kill('SIGINT');
      const [code, signal] = await new Promise((resolve) => {
        child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      expect(signal).toBeNull(); // 自分で process.exit したので signal 経由の終了ではない
      expect(code).toBe(130); // SIGINT

      // 自然な sleep 終了 (60 秒) よりずっと短い窓で死んでいることを確かめる (kill が効いていない
      // 場合に「たまたま自然終了と重なって green になる」誤検出を避ける)。
      await waitUntil(() => !pidAlive(verifyPid), { timeoutMs: 5_000 }); // 孤児にならず、確かに終わっている
    } finally {
      // アサーションが途中で失敗しても、子プロセスと (60 秒 sleep 中かもしれない) fake verify の
      // 孫プロセスを確実に後始末する。正常系ではどちらも既に死んでいるので kill は no-op になる。
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      if (verifyPid !== undefined && pidAlive(verifyPid)) {
        try {
          process.kill(verifyPid, 'SIGKILL');
        } catch {
          // 確認と kill の間に終了していれば無視する。
        }
      }
    }
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1'); // detach のまま残らない
    expect(posted().map((entry) => entry.state)).not.toContain('failure'); // 中断を failure と記録しない
    expect(stderr).toContain('SIGINT');
    expect(stderr).toContain('bd/demo-1');
    // bdboard-e8o1 (見送り分 3): 次にやり直すコマンドのヒントと、監査ログのイベント。
    expect(stderr).toContain(`そのまま次を実行してやり直せます: BDBOARD_MERGER=chair npm run merge-pr -- finish ${PR}`);
    expect(auditText()).toMatch(/\tlanded-verify-interrupted\tsha=[0-9a-f]{40}\tby=demo-1\tledger=true\tsignal=SIGINT/);
    // opus レビューで見つかった退行の固定化: 中断されたのに installAndVerify が呼び出し元へ
    // 制御を戻し、finish() の「検証を実行できなかった」エラーパスまで進んでしまわないこと。
    expect(stderr).not.toContain('着地後検証を実行できませんでした');

    // 状態・枠・台帳は壊れていないので、そのまま finish をやり直せる。
    const retried = run(['finish', String(PR)]);
    expect(retried.status).toBe(0);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('finish: SIGTERM during the landed verify kills the verify process and restores the branch (same guarantee as SIGINT, different signal)', async () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const pidFile = path.join(tmp, 'verify-term.pid');
    const child = spawn(process.execPath, [SCRIPT, 'finish', String(PR)], {
      cwd: work,
      env: { ...env, FAKE_VERIFY_SLEEP_MS: '60000', FAKE_VERIFY_PID_FILE: pidFile, BDBOARD_MERGE_KILL_GRACE_MS: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    let verifyPid;
    try {
      await waitUntil(() => {
        if (!existsSync(pidFile)) {
          return false;
        }
        const parsed = Number(readFileSync(pidFile, 'utf8').trim());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return false;
        }
        verifyPid = parsed;
        return true;
      });
      expect(pidAlive(verifyPid)).toBe(true);

      child.kill('SIGTERM');
      const [code, signal] = await new Promise((resolve) => {
        child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      expect(signal).toBeNull();
      expect(code).toBe(143); // SIGTERM

      await waitUntil(() => !pidAlive(verifyPid), { timeoutMs: 5_000 });
    } finally {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      if (verifyPid !== undefined && pidAlive(verifyPid)) {
        try {
          process.kill(verifyPid, 'SIGKILL');
        } catch {
          // 確認と kill の間に終了していれば無視する。
        }
      }
    }
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(posted().map((entry) => entry.state)).not.toContain('failure');
    expect(stderr).toContain('SIGTERM');
    expect(auditText()).toMatch(/\tlanded-verify-interrupted\tsha=[0-9a-f]{40}\tby=demo-1\tledger=true\tsignal=SIGTERM/);
    expect(stderr).not.toContain('着地後検証を実行できませんでした');

    const retried = run(['finish', String(PR)]);
    expect(retried.status).toBe(0);
  });

  it('finish: SIGINT also kills a grandchild the verify process spawns, not just the direct npm/shell child (pgid polling, 見送り分 1)', async () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const pidFile = path.join(tmp, 'verify-gc.pid');
    const grandchildPidFile = path.join(tmp, 'verify-gc-grandchild.pid');
    const child = spawn(process.execPath, [SCRIPT, 'finish', String(PR)], {
      cwd: work,
      env: {
        ...env,
        FAKE_VERIFY_SLEEP_MS: '60000',
        FAKE_VERIFY_PID_FILE: pidFile,
        FAKE_VERIFY_GRANDCHILD_PID_FILE: grandchildPidFile,
        BDBOARD_MERGE_KILL_GRACE_MS: '200',
        BDBOARD_MERGE_KILL_POLL_MS: '50',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    let verifyPid;
    let grandchildPid;
    try {
      await waitUntil(() => {
        if (!existsSync(pidFile) || !existsSync(grandchildPidFile)) {
          return false;
        }
        const v = Number(readFileSync(pidFile, 'utf8').trim());
        const g = Number(readFileSync(grandchildPidFile, 'utf8').trim());
        if (!Number.isInteger(v) || v <= 0 || !Number.isInteger(g) || g <= 0) {
          return false;
        }
        verifyPid = v;
        grandchildPid = g;
        return true;
      });
      expect(pidAlive(verifyPid)).toBe(true);
      expect(pidAlive(grandchildPid)).toBe(true);
      expect(verifyPid).not.toBe(grandchildPid);

      child.kill('SIGINT');
      // 孫は SIGTERM を無視するので、後始末 (SIGKILL への昇格 → プロセスグループが実際に
      // 空になるまでのポーリング → restoreBranch) には少なくとも killGraceMs (200ms) かかる。
      // SIGINT 直後 (t=0) ではどちらの実装でもまだ何も起きていないので区別できない — 100ms
      // 待ってから確認する: これは旧実装 (return 'error' で finally の restoreBranch が
      // 同期区間ですぐ走る。孫の SIGKILL 猶予 200ms よりずっと早く完了する) なら既にブランチが
      // 戻ってしまっているはずの時点で、新実装 (孫がまだ生きているので後始末が完了していない)
      // なら detach したままのはずの時点 — opus レビューで見つかった退行の固定化。
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pidAlive(grandchildPid)).toBe(true);
      // symbolic-ref は detached HEAD だと非ゼロ終了で失敗する (git() ヘルパーが throw する) ので
      // rev-parse --abbrev-ref を使う (detached なら文字列 'HEAD' を返す。throw しない)。
      expect(git(work, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');

      const [code, signal] = await new Promise((resolve) => {
        child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      expect(signal).toBeNull();
      expect(code).toBe(130);

      // グループ全体が本当に空になるまでポーリングで待つ (孫が生き残っていないか)。
      await waitUntil(() => !pidAlive(verifyPid) && !pidAlive(grandchildPid), { timeoutMs: 5_000 });
    } finally {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      for (const pid of [verifyPid, grandchildPid]) {
        if (pid !== undefined && pidAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // 確認と kill の間に終了していれば無視する。
          }
        }
      }
    }
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(posted().map((entry) => entry.state)).not.toContain('failure');
    expect(stderr).not.toContain('着地後検証を実行できませんでした');
  });

  it('S2 prepare (class F): SIGINT during the predicted-tree verify kills the process and restores the branch, leaving no state behind for a clean retry', async () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' }); // 衝突なし・hot file なしで main を進める → クラス F
    const pidFile = path.join(tmp, 'predicted-verify.pid');
    const child = spawn(process.execPath, [SCRIPT, 'prepare', String(PR)], {
      cwd: work,
      env: { ...env, FAKE_VERIFY_SLEEP_MS: '60000', FAKE_VERIFY_PID_FILE: pidFile, BDBOARD_MERGE_KILL_GRACE_MS: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    let verifyPid;
    try {
      await waitUntil(() => {
        if (!existsSync(pidFile)) {
          return false;
        }
        const parsed = Number(readFileSync(pidFile, 'utf8').trim());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return false;
        }
        verifyPid = parsed;
        return true;
      });
      expect(pidAlive(verifyPid)).toBe(true);

      child.kill('SIGINT');
      const [code, signal] = await new Promise((resolve) => {
        child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      expect(signal).toBeNull();
      expect(code).toBe(130);

      await waitUntil(() => !pidAlive(verifyPid), { timeoutMs: 5_000 });
    } finally {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      if (verifyPid !== undefined && pidAlive(verifyPid)) {
        try {
          process.kill(verifyPid, 'SIGKILL');
        } catch {
          // 確認と kill の間に終了していれば無視する。
        }
      }
    }
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1'); // 着地予定ツリーの detach のまま残らない
    expect(posted()).toEqual([]); // ledger:false なので元々何も投稿しない
    expect(stderr).toContain('SIGINT');
    expect(stderr).toContain(`そのまま次を実行してやり直せます: npm run merge-pr -- prepare ${PR}`);
    expect(stderr).not.toContain('着地予定ツリーの verify を実行できませんでした');
    expect(existsSync(stateFile())).toBe(false); // 記録が残らないのでそのまま prepare し直せる

    const retried = run(['prepare', String(PR)]);
    expect(retried.status).toBe(0);
    expect(readState()).toMatchObject({ class: 'F' });
  });

  it('S2 prepare (class F): the untracked-file guard judges by the predicted landed tree\'s .gitignore, not the branch currently checked out', () => {
    setup({ merge: { mode: 'S2' } });
    // main が新しく .gitignore を追加する (PR 側は .gitignore を触らないのでクラス F のまま)。
    // 現在チェックアウトしている bd/demo-1 には .gitignore が無いので、判定を checkout 前に
    // 行うと (旧実装) stray.log は「ignore されていない未追跡ファイル」として誤ってブロック
    // される。着地予定ツリー (main の .gitignore を含む) を detach した後に判定すれば無視される。
    advanceMain({ '.gitignore': 'stray.log\n' });
    writeFileSync(path.join(work, 'stray.log'), 'noise\n');
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).not.toContain('未追跡ファイル');
    expect(readState()).toMatchObject({ class: 'F' });
  });
});
