// bdboard-wea0.1 (設計 bdboard-wea0 §7 T2): verify.mjs が worktree lock を正しい期間だけ持つことを実プロセスと実際の kill で
// 確かめる。verify.mjs の import graph を `git init` した一時ディレクトリへコピーし、PATH 先頭の偽の npm で受ける
// (worktree-lock.test-support.mjs)。kill するのは自分が起こした verify と、そのリーダーのグループ (偽の npm が書いた pid) だけ。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { withoutSlotIdentity } from './verify-slot.mjs';
import { readOwner } from './worktree-lock-owner.mjs';
import { openWorktreeLock } from './worktree-lock.mjs';
import { injectReleaseFailure, isAlive, probeLock, realProcessLockTestsSkipped, waitFor, writeVerifyCopy } from './worktree-lock.test-support.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const tempDirs = [];
const children = [];
const leaderGroups = [];
const heldLocks = [];

const running = (child) => child.exitCode === null && child.signalCode === null;

// リーダーのグループを kill するのは、自分の子 (外側の verify) の handle がまだ終わっていないときだけ (レビュー指摘 8)。
// 外側を SIGKILL したあとのリーダーは自分で孤児のグループを畳むか、偽の npm の上限 (約 10 秒) で終わる。
afterEach(() => {
  for (const { pid, outer } of leaderGroups.splice(0)) {
    if (running(outer)) {
      process.kill(-pid, 'SIGKILL');
    }
  }
  children.splice(0).filter(running).forEach((child) => child.kill('SIGKILL'));
  heldLocks.splice(0).forEach((lock) => lock.release());
  tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

const makeTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

/** git init 済みの一時 worktree に verify.mjs と偽の npm を置く。 */
const makeWorktree = () => {
  const root = makeTempDir('verify-worktree-lock-');
  writeVerifyCopy(scriptsDir, root);
  expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
  return { root, lockPath: path.join(root, '.git', 'bdboard-worktree.lock'), slotDir: makeTempDir('verify-worktree-lock-slots-') };
};

const verifyEnv = (worktree, name, extra = {}) => ({
  ...withoutSlotIdentity(process.env),
  BDBOARD_WORKTREE_LOCK: undefined,
  BDBOARD_FLOCK_HELPER: undefined,
  PATH: `${path.join(worktree.root, 'fake-bin')}${path.delimiter}${process.env.PATH ?? ''}`,
  FAKE_NPM_MARKER: path.join(worktree.root, `${name}.marker`),
  FAKE_NPM_LEADER: path.join(worktree.root, `${name}.leader`),
  BDBOARD_VERIFY_SLOT_DIR: worktree.slotDir,
  ...extra,
});

const runVerify = (worktree, name, extra) =>
  spawnSync(process.execPath, [path.join(worktree.root, 'scripts', 'verify.mjs')], { cwd: worktree.root, encoding: 'utf8', env: verifyEnv(worktree, name, extra), timeout: 20_000 });

const startVerify = (worktree, name, extra) => {
  const child = spawn(process.execPath, [path.join(worktree.root, 'scripts', 'verify.mjs')], { cwd: worktree.root, env: verifyEnv(worktree, name, extra), stdio: 'ignore' });
  children.push(child);
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, done };
};

const npmRan = (worktree, name) => fs.existsSync(path.join(worktree.root, `${name}.marker`));
const leaderOf = async (worktree, name, outer) => {
  await waitFor(() => npmRan(worktree, name), 10_000, `${name}: fake npm started`);
  const pid = Number(fs.readFileSync(path.join(worktree.root, `${name}.leader`), 'utf8').trim());
  leaderGroups.push({ pid, outer });
  return pid;
};

/** merge-pr (wea0.2) の代わりに、テストのプロセス自身が lock を持ち、持ち主として merge-pr を書く。 */
const holdAsMergePr = (worktree, { pid, downgrade }) => {
  const lock = openWorktreeLock({ path: worktree.lockPath, env: {} });
  heldLocks.push(lock);
  expect(lock.tryLock('EX').ok).toBe(true);
  lock.writeOwner({ by: 'merge-pr finish 869', pid, phase: downgrade ? 'verify' : 'checkout', sha: 'abc', cwd: worktree.root, at: 'T' });
  if (downgrade) {
    expect(lock.tryLock('SH').ok).toBe(true);
  }
  return lock;
};

describe.skipIf(realProcessLockTestsSkipped)('verify.mjs holds the worktree lock (real processes, real kills)', { timeout: 40_000 }, () => {
  it('takes SH before the slot wait and keeps it while queued (symptom 5); the lock is free once the queued verify exits', async () => {
    const worktree = makeWorktree();
    const slotHolder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.push(slotHolder);
    fs.writeFileSync(path.join(worktree.slotDir, `holder-${slotHolder.pid}.json`), JSON.stringify({ pid: slotHolder.pid, joinedAt: Date.now() - 1_000, cwd: '/fake' }));
    const queued = startVerify(worktree, 'queued', { BDBOARD_VERIFY_SLOTS: '1', BDBOARD_VERIFY_SLOT_WAIT_MS: '30000' });
    await waitFor(() => probeLock(worktree.lockPath, 'SH') === 'free' && probeLock(worktree.lockPath, 'EX') === 'busy', 10_000, 'queued verify holds SH (after its brief EX)');
    expect(readOwner(worktree.lockPath)).toMatchObject({ by: 'npm run verify', pid: queued.child.pid, phase: 'verify' });
    expect(npmRan(worktree, 'queued')).toBe(false); // まだスロット待ち
    queued.child.kill('SIGTERM');
    expect(await queued.done).toEqual({ code: 143, signal: null });
    expect(probeLock(worktree.lockPath, 'EX')).toBe('free');
  });

  it('S4: SIGKILL of the outer verify leaves the lock with the leader (fd 3) until the leader dies', async () => {
    const worktree = makeWorktree();
    const run = startVerify(worktree, 'a', { FAKE_NPM_RELEASE: path.join(worktree.root, 'never') });
    const leader = await leaderOf(worktree, 'a', run.child);
    run.child.kill('SIGKILL');
    await run.done;
    expect(isAlive(leader)).toBe(true);
    expect(probeLock(worktree.lockPath, 'EX')).toBe('busy');
    expect(probeLock(worktree.lockPath, 'SH')).toBe('free');
    await waitFor(() => !isAlive(leader), 20_000, 'orphaned leader folds its group');
    expect(probeLock(worktree.lockPath, 'EX')).toBe('free');
  });

  it('S2: SIGKILL of the outer and the leader group frees the lock', async () => {
    const worktree = makeWorktree();
    const run = startVerify(worktree, 'a', { FAKE_NPM_RELEASE: path.join(worktree.root, 'never') });
    const leader = await leaderOf(worktree, 'a', run.child);
    expect(probeLock(worktree.lockPath, 'EX')).toBe('busy');
    run.child.kill('SIGKILL');
    process.kill(-leader, 'SIGKILL');
    await run.done; // handle の終了を反映させる (afterEach が死んだグループを kill しに行かない)
    await waitFor(() => probeLock(worktree.lockPath, 'EX') === 'free', 5_000, 'lock freed by the kernel');
  });

  it('refuses at once (exit 1, owner and lsof shown) when a merge-pr with another pid owns the worktree', () => {
    const worktree = makeWorktree();
    holdAsMergePr(worktree, { pid: 4242, downgrade: true });
    for (const heldBy of [undefined, '4243']) {
      const result = runVerify(worktree, 'manual', { BDBOARD_WORKTREE_HELD_BY: heldBy });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('merge-pr finish 869 (pid 4242, phase verify, sha abc, since T) — a merge-pr owns it');
      expect(result.stderr).not.toContain('exclusively'); // 持ち主を見て拒否した (待ちの打ち切りではない。gate 問1 の既定)
      expect(result.stderr).toContain(`lsof -t '`);
      expect(npmRan(worktree, 'manual')).toBe(false);
    }
  });

  it('refuses during the merge-pr EX window (tree being switched) as well, by its owner line and without waiting', () => {
    const worktree = makeWorktree();
    holdAsMergePr(worktree, { pid: 4242, downgrade: false });
    const manual = runVerify(worktree, 'manual');
    expect(manual.status, manual.stderr).toBe(1);
    expect(manual.stderr).toContain('phase checkout, sha abc, since T) — a merge-pr owns it');
    expect(npmRan(worktree, 'manual')).toBe(false);
  });

  it('proceeds when BDBOARD_WORKTREE_HELD_BY names the merge-pr, and does not pass that variable to the steps', () => {
    const worktree = makeWorktree();
    holdAsMergePr(worktree, { pid: 4242, downgrade: true });
    const result = runVerify(worktree, 'contract', { BDBOARD_WORKTREE_HELD_BY: '4242' });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(worktree.root, 'contract.marker'), 'utf8')).toBe('BDBOARD_WORKTREE_HELD_BY=-\n');
  });

  it('two manual verifies in one worktree share it', async () => {
    const worktree = makeWorktree();
    const release = path.join(worktree.root, 'release-a');
    const first = startVerify(worktree, 'a', { FAKE_NPM_RELEASE: release });
    await leaderOf(worktree, 'a', first.child);
    const second = runVerify(worktree, 'b');
    expect(second.status, second.stderr).toBe(0);
    expect(npmRan(worktree, 'b')).toBe(true);
    expect(isAlive(first.child.pid)).toBe(true);
    expect(probeLock(worktree.lockPath, 'EX')).toBe('busy'); // 2 本目が終わっても 1 本目の lock は同じファイルに残る (消さない)
    fs.writeFileSync(release, '');
    expect(await first.done).toEqual({ code: 0, signal: null });
    expect(probeLock(worktree.lockPath, 'EX')).toBe('free');
  });

  it('a release that throws when the leader exits does not turn a passing verify red (re-review N2)', () => {
    const worktree = makeWorktree();
    injectReleaseFailure(worktree.root);
    const result = runVerify(worktree, 'a');
    expect([result.status, npmRan(worktree, 'a')], result.stderr).toEqual([0, true]);
  });

  it('without a helper it prints one stderr line and runs unlocked', () => {
    const worktree = makeWorktree();
    const result = runVerify(worktree, 'a', { BDBOARD_FLOCK_HELPER: '["/nonexistent/flock-helper"]' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.split('\n').filter((line) => line.includes('worktree lock'))).toHaveLength(1);
    expect(result.stderr).toContain('no flock helper');
    expect(readOwner(worktree.lockPath)).toBe(null);
  });

  it('BDBOARD_WORKTREE_LOCK=off warns on stderr and runs even in a merge-pr-owned worktree', () => {
    const worktree = makeWorktree();
    holdAsMergePr(worktree, { pid: 4242, downgrade: true });
    const result = runVerify(worktree, 'a', { BDBOARD_WORKTREE_LOCK: 'off' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('BDBOARD_WORKTREE_LOCK=off');
    expect(result.stderr).toContain('WITHOUT the worktree lock');
  });
});
