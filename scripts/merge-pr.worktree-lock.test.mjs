// bdboard-wea0.2 (設計 bdboard-wea0 §7 T3–T6): merge-pr が worktree lock (scripts/worktree-lock.mjs) を正しい期間だけ持つことを、
// 実プロセスと実際の kill で確かめる。PID・開始時刻・年齢の記録 (verifying-record / verify-guard / predicted-guard) を
// 置き換えたテスト (旧 merge-pr.verifying-record / prepare-orphan / finish-identity.test.mjs の代わり)。
//
// 時計に頼らない: 偽の verify は FAKE_VERIFY_RELEASE のファイルが現れるまで待ち (最大 60 秒)、起動したことを
// FAKE_VERIFY_STARTED に残す。テストは「起動した」を見てから kill・2 本目の実行・lock の観測をし、終わらせたいときに
// release を書く。lock の観測は検査対象を使わない perl の probe (worktree-lock.test-support.mjs)。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { VERIFY_JS } from './merge-pr.test-support-verify-js.mjs';
import { advanceMain, env, git, mainCheckout, posted, PR, readFake, readState, registerTempRepoHooks, run, SCRIPT, setup, simulateMerge, tmp, verified, work } from './merge-pr.test-support.mjs';
import { readOwner } from './worktree-lock-owner.mjs';
import { isAlive, probeLock, realProcessLockTestsSkipped, waitFor } from './worktree-lock.test-support.mjs';
import { openWorktreeLock } from './worktree-lock.mjs';

// release のファイルか、テストのプロセス (FAKE_VERIFY_TEST_PID) が居なくなるまで待つ。時計では終わらない (#876 レビュー N5)。
const WAIT_FOR_RELEASE = `
const testAlive = () => { try { process.kill(Number(process.env.FAKE_VERIFY_TEST_PID), 0); return true; } catch { return false; } };
while (process.env.FAKE_VERIFY_RELEASE && !fs.existsSync(process.env.FAKE_VERIFY_RELEASE) && testAlive()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
`;
const GATED = `{
  const fs = require('node:fs');
  if (process.env.FAKE_VERIFY_STARTED) fs.appendFileSync(process.env.FAKE_VERIFY_STARTED, process.pid + '\\n');
  ${WAIT_FOR_RELEASE}
}
`;
// verify.mjs の外側が lock を取る手順 (verify-worktree-claim.mjs) をそのまま契約の verify にする: merge-pr が持つ lock を共有できれば 0。
const CLAIM = fileURLToPath(new URL('./verify-worktree-claim.mjs', import.meta.url));
const CLAIM_VERIFY_JS = `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
import(pathToFileURL(${JSON.stringify(CLAIM)}).href).then(async ({ claimWorktreeForVerify }) => {
  const claimed = await claimWorktreeForVerify({ repoRoot: process.cwd(), log: (line) => process.stderr.write(line + '\\n') });
  const outcome = claimed.exitCode === null ? (claimed.lock ? 'locked' : 'unlocked') : claimed.exitCode;
  fs.appendFileSync(process.env.FAKE_VERIFY_LOG, execSync('git rev-parse HEAD').toString().trim() + ' claim=' + outcome + '\\n');
  process.exit(outcome === 'locked' ? 0 : 1);
});
`;
// 偽の npm ci: fd 3 が lock のファイルか (同じ dev+ino か) を残し、release まで待つ。
const FAKE_NPM_CI = `
const fs = require('node:fs');
let isLock = false;
try { const held = fs.fstatSync(3); const onDisk = fs.statSync(process.env.FAKE_NPM_LOCK_PATH); isLock = held.dev === onDisk.dev && held.ino === onDisk.ino; } catch {}
fs.writeFileSync(process.env.FAKE_NPM_MARKER + '.tmp', JSON.stringify({ isLock, pid: process.pid, args: process.argv.slice(2) }));
fs.renameSync(process.env.FAKE_NPM_MARKER + '.tmp', process.env.FAKE_NPM_MARKER);
${WAIT_FOR_RELEASE}`;

const children = [];
const orphans = [];
const heldLocks = [];
const lockPath = () => path.join(git(work, ['rev-parse', '--absolute-git-dir']), 'bdboard-worktree.lock');
const mergeDir = () => path.join(mainCheckout, '.git', 'bdboard-merge');
const startedFile = () => path.join(tmp, 'started.log');
const releaseFile = () => path.join(tmp, 'release');
const gateEnv = () => ({ FAKE_VERIFY_STARTED: startedFile(), FAKE_VERIFY_RELEASE: releaseFile(), FAKE_VERIFY_TEST_PID: String(process.pid) });
const releaseVerify = () => writeFileSync(releaseFile(), '');
const started = () => (existsSync(startedFile()) ? readFileSync(startedFile(), 'utf8').split('\n').filter(Boolean).map(Number) : []);
const onBranch = () => spawnSync('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: work, encoding: 'utf8' }).stdout.trim();
const WAIT_MS = 120_000; // 条件が成り立てばすぐ返るので、速い実行では何も失わない (#876 レビュー N5)

function spawnMergePr(args, extraEnv = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: work, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderrText = '';
  child.stderr.on('data', (chunk) => {
    child.stderrText += chunk.toString();
  });
  child.stdout.resume();
  child.done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  children.push(child);
  return child;
}

/** このテストが持つ lock (手動の verify・残った verify の代わり)。 */
function holdShared() {
  const lock = openWorktreeLock({ path: lockPath() });
  heldLocks.push(lock);
  expect(lock.tryLock('SH').ok).toBe(true);
  return lock;
}

/** 手動の verify (BDBOARD_WORKTREE_HELD_BY 無し) が lock を取る手順を、別プロセスで 1 回走らせた結果。 */
function manualClaim() {
  const script = `import(${JSON.stringify(`file://${CLAIM}`)}).then(async ({ claimWorktreeForVerify }) => { const c = await claimWorktreeForVerify({ repoRoot: process.cwd(), log: () => {} }); process.stdout.write(String(c.exitCode)); })`;
  const childEnv = { ...env, BDBOARD_WORKTREE_HELD_BY: '' };
  return spawnSync(process.execPath, ['-e', script], { cwd: work, env: childEnv, encoding: 'utf8' }).stdout;
}

function gatedAndMerged(verifyJs = GATED + VERIFY_JS) {
  setup({ branchFiles: { 'verify.cjs': verifyJs } });
  expect(run(['prepare', String(PR)]).status).toBe(0);
  expect(run(['gate', String(PR)]).status).toBe(0);
  return simulateMerge();
}

describe.skipIf(realProcessLockTestsSkipped)('merge-pr holds the worktree lock (bdboard-wea0.2)', { timeout: 600_000 }, () => {
  registerTempRepoHooks();
  afterEach(() => {
    children.splice(0).filter((child) => child.exitCode === null && child.signalCode === null).forEach((child) => child.kill('SIGKILL'));
    for (const pid of [...orphans.splice(0), ...(tmp ? started() : [])]) {
      if (isAlive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
    heldLocks.splice(0).forEach((lock) => lock.release());
  });

  it('T3a: SIGKILL finish mid-verify → the verify keeps the lock; a rerun exits 75 naming the owner and starts no second verify; once it is gone the rerun proceeds', async () => {
    const landed = gatedAndMerged();
    const first = spawnMergePr(['finish', String(PR)], gateEnv());
    await waitFor(() => started().length === 1, WAIT_MS, 'the landed verify started');
    first.kill('SIGKILL');
    await first.done;
    expect(probeLock(lockPath())).toBe('busy'); // 契約の verify が fd 3 で受け継いだ記述が lock を持ち続ける
    const rerun = run(['finish', String(PR)], gateEnv());
    expect(rerun.status).toBe(75);
    expect(rerun.stderr).toContain(`merge-pr finish ${PR} (pid ${first.pid}, phase verify`);
    expect(rerun.stderr).toContain(`lsof -t '${lockPath()}'`);
    expect(started()).toHaveLength(1); // 2 本目の verify は起こさない
    expect(manualClaim()).toBe('1'); // 手動の verify も、merge-pr の detach した木では走らない
    process.kill(started()[0], 'SIGKILL');
    await waitFor(() => probeLock(lockPath()) === 'free', WAIT_MS, 'the lock is free once the orphan verify is gone');
    releaseVerify();
    const again = run(['finish', String(PR)], gateEnv());
    expect(again.status, again.stderr).toBe(0);
    expect(started()).toHaveLength(2);
    expect(verified()).toEqual([landed]);
  });

  it('T3b: two concurrent finishes → the second exits 75, the first completes with exit 0 (no false 143)', async () => {
    gatedAndMerged();
    const first = spawnMergePr(['finish', String(PR)], gateEnv());
    await waitFor(() => started().length === 1, WAIT_MS, 'the landed verify started');
    const second = run(['finish', String(PR)], gateEnv());
    expect(second.status).toBe(75);
    expect(second.stderr).toContain(`merge-pr finish ${PR} (pid ${first.pid}, phase verify`);
    expect(second.stderr).toContain('枠は前の finish で返してあります');
    releaseVerify();
    const { code } = await first.done;
    expect(code, first.stderrText).toBe(0);
    expect(first.stderrText).not.toMatch(/SIGTERM|SIGINT|exit 143/);
    expect(started()).toHaveLength(1);
    expect(onBranch()).toBe('bd/demo-1');
    expect(readOwner(lockPath())).toMatchObject({ by: `merge-pr finish ${PR}`, pid: first.pid, phase: 'done' });
  });

  it('T3c: SIGINT → the verify is killed, the branch restored, the lock free, and no verifying*/verifyPgid* fields in the state file', async () => {
    gatedAndMerged();
    const child = spawnMergePr(['finish', String(PR)], { ...gateEnv(), BDBOARD_MERGE_KILL_GRACE_MS: '200' });
    await waitFor(() => started().length === 1, WAIT_MS, 'the landed verify started');
    child.kill('SIGINT');
    expect((await child.done).code).toBe(130);
    expect(probeLock(lockPath())).toBe('free');
    expect(onBranch()).toBe('bd/demo-1');
    expect(readOwner(lockPath())).toMatchObject({ by: `merge-pr finish ${PR}`, phase: 'done' });
    const state = readState();
    for (const field of ['verifyingPid', 'verifyingAt', 'verifyingStart', 'verifyPgid', 'verifyPgidAt', 'verifyPgidStart']) {
      expect(state).not.toHaveProperty(field);
    }
  });

  it('T3d: an SH still held after the verify ends → the result is reported normally, with a "restore pending" line and the tree left detached', async () => {
    const landed = gatedAndMerged();
    const child = spawnMergePr(['finish', String(PR)], { ...gateEnv(), BDBOARD_MERGE_RESTORE_WAIT_MS: '400' });
    await waitFor(() => started().length === 1, WAIT_MS, 'the landed verify started');
    const mine = holdShared();
    releaseVerify();
    const { code } = await child.done;
    expect(code, child.stderrText).toBe(0);
    expect(posted().at(-1)).toMatchObject({ sha: landed, state: 'success' });
    expect(child.stderrText).toContain(`restore を保留しました: 作業ツリーは ${landed.slice(0, 12)} で detach したままです`);
    expect(child.stderrText).toContain('が空になったら git checkout bd/demo-1 で戻してください');
    expect(git(work, ['rev-parse', 'HEAD'])).toBe(landed);
    expect(onBranch()).toBe('');
    mine.release();
    expect(probeLock(lockPath())).toBe('free');
  });

  it("T3e: the contract verify runs under merge-pr's lock with BDBOARD_WORKTREE_HELD_BY, so verify.mjs's claim shares it instead of refusing", () => {
    const landed = gatedAndMerged(CLAIM_VERIFY_JS);
    const finished = run(['finish', String(PR)]);
    expect(finished.status, finished.stderr).toBe(0);
    expect(verified()).toEqual([`${landed} claim=locked`]);
  });

  it('a first finish that finds the worktree busy returns the merge slot before exiting 75, and says to rerun the same finish (#876 review 1)', () => {
    const landed = gatedAndMerged();
    expect(readFake().slot.holder).not.toBeNull();
    const mine = holdShared(); // 手動の verify がこの worktree で並んでいる
    const busy = run(['finish', String(PR)], gateEnv());
    expect(busy.status).toBe(75);
    expect(busy.stderr).toContain('枠は返しました (着地後検証はまだです)');
    expect(busy.stderr).toContain(`finish ${PR} をやり直してください (prepare ではありません)`);
    expect(readFake().slot.holder).toBeNull();
    expect(posted()).toEqual([]);
    mine.release();
    releaseVerify();
    const again = run(['finish', String(PR)], gateEnv());
    expect(again.status, again.stderr).toBe(0);
    expect(verified()).toEqual([landed]);
  });

  it('T4a: two concurrent prepares of one PR → the second exits 75 naming the first, the first exits 0', async () => {
    setup({ merge: { mode: 'S2' }, branchFiles: { 'verify.cjs': GATED + VERIFY_JS } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const first = spawnMergePr(['prepare', String(PR)], gateEnv());
    await waitFor(() => started().length === 1, WAIT_MS, 'the predicted verify started');
    const second = run(['prepare', String(PR)], gateEnv());
    expect(second.status).toBe(75);
    expect(second.stderr).toContain(`merge-pr prepare ${PR} (pid ${first.pid}, phase verify`);
    expect(second.stderr).not.toContain('終わっています');
    releaseVerify();
    expect((await first.done).code, first.stderrText).toBe(0);
    expect(readState().class).toBe('F');
    expect(started()).toHaveLength(1);
  });

  it('T4b: SIGKILL prepare during the predicted verify → a rerun exits 75 before any checkout advice; after the orphan ends the rerun gives the advice', async () => {
    setup({ merge: { mode: 'S2' }, branchFiles: { 'verify.cjs': GATED + VERIFY_JS } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const first = spawnMergePr(['prepare', String(PR)], gateEnv());
    await waitFor(() => started().length === 1, WAIT_MS, 'the predicted verify started');
    first.kill('SIGKILL');
    await first.done;
    const rerun = run(['prepare', String(PR)], gateEnv());
    expect(rerun.status).toBe(75);
    expect(rerun.stderr).not.toContain('git checkout bd/demo-1');
    releaseVerify();
    await waitFor(() => probeLock(lockPath()) === 'free', WAIT_MS, 'the orphan verify ended');
    const after = run(['prepare', String(PR)]);
    expect(after.status).toBe(2);
    expect(after.stderr).toContain('HEAD が detach されたままです (verify の中断?)。git checkout bd/demo-1 で戻してください。');
  });

  it('T4c/T4d: --dry-run exits 75 while the lock is busy, writes no owner line and leaves an old predicted-verify record; a real prepare deletes that record', () => {
    setup();
    const stale = path.join(mergeDir(), `pr-${PR}-predicted-verify.json`);
    mkdirSync(mergeDir(), { recursive: true });
    writeFileSync(stale, JSON.stringify({ pr: PR, verifyPgid: process.pid, verifyPgidAt: new Date().toISOString() }));
    const mine = holdShared();
    const busy = run(['prepare', String(PR), '--dry-run']);
    expect(busy.status).toBe(75);
    expect(busy.stderr).toContain('この worktree は worktree lock で使用中なので分類も表示しません');
    mine.release();
    writeFileSync(lockPath(), ''); // 同じ inode のまま空にする (消さない)
    expect(run(['prepare', String(PR), '--dry-run']).status).toBe(0);
    expect(readFileSync(lockPath(), 'utf8')).toBe('');
    expect(existsSync(stale)).toBe(true);
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(probeLock(lockPath())).toBe('free');
  });

  it('T5: npm ci gets the lock as fd 3, so a SIGKILLed prepare leaves the lock held until npm ci exits (symptom 4)', async () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'package-lock.json': '{"lockfileVersion":3}\n' });
    const fakeNpm = path.join(tmp, 'fake-npm-ci.cjs');
    writeFileSync(fakeNpm, FAKE_NPM_CI);
    const marker = path.join(tmp, 'npm-ci.json');
    const npmEnv = { ...gateEnv(), BDBOARD_MERGE_NPM: JSON.stringify([process.execPath, fakeNpm]), FAKE_NPM_LOCK_PATH: lockPath(), FAKE_NPM_MARKER: marker };
    const first = spawnMergePr(['prepare', String(PR)], npmEnv);
    await waitFor(() => existsSync(marker), WAIT_MS, 'npm ci started');
    const seen = JSON.parse(readFileSync(marker, 'utf8'));
    orphans.push(seen.pid);
    expect(seen).toMatchObject({ isLock: true, args: ['ci'] });
    first.kill('SIGKILL');
    await first.done;
    expect(probeLock(lockPath())).toBe('busy');
    releaseVerify();
    await waitFor(() => !isAlive(seen.pid), WAIT_MS, 'the fake npm ci exited');
    await waitFor(() => probeLock(lockPath()) === 'free', WAIT_MS, 'the lock is free after npm ci');
  });

  it('T6: garbage in the lock file changes nothing about locking: 75 says the owner is unreadable and gives the lsof line; no record file exists', () => {
    setup();
    const mine = holdShared();
    writeFileSync(lockPath(), 'garbage-not-json\n');
    const busy = run(['prepare', String(PR)]);
    expect(busy.status).toBe(75);
    expect(busy.stderr).toContain('owner unreadable: garbage-not-json');
    expect(busy.stderr).toContain(`lsof -t '${lockPath()}'`);
    mine.release();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(readOwner(lockPath())).toMatchObject({ by: `merge-pr prepare ${PR}`, phase: 'done' });
    expect(readdirSync(mergeDir()).filter((name) => name.includes('predicted-verify'))).toEqual([]);
  });

  it('refuses (exit 1) without a working flock helper, when the self-check finds a lock that does not exclude a second descriptor, and in the main checkout', () => {
    setup();
    const none = run(['prepare', String(PR)], { BDBOARD_FLOCK_HELPER: JSON.stringify([path.join(tmp, 'no-such-helper')]) });
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('worktree lock を使えないので merge-pr は動きません');
    // 何もせず 0 で終わるヘルパー = lock を取ったと言うが何も排他しない (NFS の偽の lock の代わり)。
    const noLock = { BDBOARD_FLOCK_HELPER: JSON.stringify([process.execPath, '-e', '']) };
    const fake = run(['prepare', String(PR)], noLock);
    expect(fake.status).toBe(1);
    expect(fake.stderr).toContain('worktree lock の自己検査に失敗しました');
    const probe = run(['prepare', String(PR), '--dry-run'], noLock); // --dry-run の試しも自己検査する
    expect(probe.status).toBe(1);
    expect(probe.stderr).toContain('worktree lock の自己検査に失敗しました');
    // #876 レビュー N1: main checkout では lock を取らずに止まる (常時稼働サーバーの deploy --verify を拒否させない)。
    for (const args of [['prepare', String(PR)], ['prepare', String(PR), '--dry-run']]) {
      const fromMain = run(args, {}, mainCheckout);
      expect(fromMain.status).toBe(1);
      expect(fromMain.stderr).toContain('merge-pr は PR の worktree (git worktree add で作った作業ツリー) で実行します');
    }
    expect(existsSync(path.join(mainCheckout, '.git', 'bdboard-worktree.lock'))).toBe(false);
  });
});
