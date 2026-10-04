// bdboard-wea0.1 (設計 bdboard-wea0 §7 T1): scripts/worktree-lock.mjs を実プロセスで確かめる。観測は独立した
// perl プローブ (worktree-lock.test-support.mjs の probeLock) で行い、検査対象の lock オブジェクトの自己申告は信じない。
// 実プロセスのテストは win32 とヘルパー (perl) の無い環境で skip。win32 の no-op は platform 注入でどこでも走らせる。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeOwner, lsofHint, readOwner } from './worktree-lock-owner.mjs';
import { flockHelperCandidates, FLOCK_HELPER_ENV, OP, openWorktreeLock, PERL_FLOCK_HELPER, PYTHON_FLOCK_HELPER, runFlockHelper } from './worktree-lock.mjs';
import { helperWorks, probeLock, realProcessLockTestsSkipped } from './worktree-lock.test-support.mjs';

const tempDirs = [];
const openLocks = [];

afterEach(() => {
  openLocks.splice(0).forEach((lock) => lock.release());
  tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

const tempLockPath = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-lock-'));
  tempDirs.push(dir);
  return path.join(dir, 'bdboard-worktree.lock');
};

const open = (lockPath, options = {}) => {
  const lock = openWorktreeLock({ path: lockPath, env: { [FLOCK_HELPER_ENV]: undefined }, ...options });
  openLocks.push(lock);
  return lock;
};

const pythonAvailable = !realProcessLockTestsSkipped && helperWorks(tempLockPath(), PYTHON_FLOCK_HELPER);

describe('win32 (platform injection): no-op that spawns nothing', () => {
  it('returns an unsupported lock without opening the file or spawning a helper', () => {
    const spawn = vi.fn();
    const lock = openWorktreeLock({ path: '/nonexistent-dir/bdboard-worktree.lock', platform: 'win32', spawnSync: spawn });
    expect(lock.supported).toBe(false);
    expect(lock.fd).toBe(null);
    expect(lock.tryLock('EX')).toMatchObject({ ok: false, outcome: 'unsupported' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('owner content and messages (pure)', () => {
  it('describes owners and quotes the lsof path for the shell', () => {
    expect(describeOwner({ by: 'merge-pr finish 1', pid: 7, phase: 'checkout', sha: '0123456789abcdef', at: 'T' })).toBe(
      'merge-pr finish 1 (pid 7, phase checkout, sha 0123456789ab, since T)',
    );
    expect(describeOwner({ unreadable: 'x' })).toContain('owner unreadable');
    expect(lsofHint("/tmp/a b/it's.lock")).toBe("lsof -t '/tmp/a b/it'\\''s.lock'");
  });

  it('BDBOARD_FLOCK_HELPER replaces perl/python3 instead of adding to them; an invalid value means no helper', () => {
    expect(flockHelperCandidates({})).toEqual([PERL_FLOCK_HELPER, PYTHON_FLOCK_HELPER]);
    expect(flockHelperCandidates({ [FLOCK_HELPER_ENV]: '["/opt/flock","-x"]' })).toEqual([['/opt/flock', '-x']]);
    expect(flockHelperCandidates({ [FLOCK_HELPER_ENV]: 'perl' })).toEqual([]);
    expect(flockHelperCandidates({ [FLOCK_HELPER_ENV]: '[]' })).toEqual([]);
  });

  it('every helper call is bounded by a timeout; a timed-out or killed helper is an error, never locked or busy', () => {
    const options = [];
    const timedOut = (command, args, spawnOptions) => {
      options.push(spawnOptions);
      return { error: new Error('spawnSync perl ETIMEDOUT'), status: null, signal: 'SIGTERM' };
    };
    expect(runFlockHelper(PERL_FLOCK_HELPER, 99, OP.EX | OP.NB, timedOut)).toBe('error');
    expect(options[0].timeout).toBeGreaterThan(0);
    expect(runFlockHelper(PERL_FLOCK_HELPER, 99, OP.EX | OP.NB, () => ({ status: null, signal: 'SIGKILL' }))).toBe('error');
  });
});

describe.skipIf(realProcessLockTestsSkipped)('worktree lock against a real perl probe', { timeout: 20_000 }, () => {
  it('EX keeps every other description out; EX->SH lets SH in; SH->EX and release work', () => {
    const lockPath = tempLockPath();
    const lock = open(lockPath);
    expect(lock.helper).toEqual(PERL_FLOCK_HELPER);
    expect(lock.tryLock('EX')).toEqual({ ok: true, outcome: 'locked', held: 'EX', converted: null });
    expect([probeLock(lockPath, 'EX'), probeLock(lockPath, 'SH')]).toEqual(['busy', 'busy']);
    expect(lock.tryLock('SH')).toEqual({ ok: true, outcome: 'locked', held: 'SH', converted: 'EX->SH' });
    expect([probeLock(lockPath, 'EX'), probeLock(lockPath, 'SH')]).toEqual(['busy', 'free']);
    expect(lock.tryLock('EX')).toMatchObject({ ok: true, held: 'EX', converted: 'SH->EX' });
    expect(probeLock(lockPath, 'SH')).toBe('busy');
    lock.release();
    expect(probeLock(lockPath, 'EX')).toBe('free');
    expect(fs.existsSync(lockPath)).toBe(true); // release は閉じるだけで、ファイルは消さない (E5)
  });

  it('a second description in the same process is busy, and closing it leaves the first lock in place (E1)', () => {
    const lockPath = tempLockPath();
    const first = open(lockPath);
    expect(first.tryLock('EX').ok).toBe(true);
    const second = open(lockPath);
    expect(second.tryLock('SH')).toEqual({ ok: false, outcome: 'busy', held: null, converted: null });
    second.release();
    expect(probeLock(lockPath, 'EX')).toBe('busy');
  });

  it('a refused SH->EX conversion is returned, not thrown, and leaves the object holding nothing (E4)', () => {
    const lockPath = tempLockPath();
    const upgrading = open(lockPath);
    const sharer = open(lockPath);
    expect(upgrading.tryLock('SH').ok).toBe(true);
    expect(sharer.tryLock('SH').ok).toBe(true);
    expect(upgrading.tryLock('EX')).toEqual({ ok: false, outcome: 'busy', held: null, converted: 'SH->EX' });
    expect(upgrading.mode).toBe(null);
    sharer.release();
    expect(probeLock(lockPath, 'EX')).toBe('free'); // 「何も持っていない」は自己申告ではなく実際にそう
  });

  it('a refused EX->SH conversion (the macOS downgrade gap) is reported and unlocks, not kept silently as EX', () => {
    const lockPath = tempLockPath();
    // SH|NB (5) だけ「塞がっている」と答えるヘルパー: 降格の隙間に他者が EX を取ったときと同じ返事。
    const refuseShared = (command, args, options) => (args[args.length - 1] === '5' ? { status: 1 } : spawnSync(command, args, options));
    const lock = open(lockPath, { spawnSync: refuseShared });
    expect(lock.tryLock('EX').ok).toBe(true);
    expect(lock.tryLock('SH')).toEqual({ ok: false, outcome: 'busy', held: null, converted: 'EX->SH' });
    expect(probeLock(lockPath, 'EX')).toBe('free');
  });

  it('after release every operation is refused without spawning a helper (E11: no flock on a reused fd number)', () => {
    const lockPath = tempLockPath();
    const spawn = vi.fn(spawnSync);
    const lock = open(lockPath, { spawnSync: spawn });
    expect(lock.tryLock('EX').ok).toBe(true);
    lock.release();
    const callsAfterRelease = spawn.mock.calls.length;
    expect(lock.fd).toBe(null);
    expect(lock.tryLock('EX')).toMatchObject({ ok: false, outcome: 'released' });
    expect(lock.writeOwner({ by: 'x' })).toBe(false);
    expect(lock.selfCheck().ok).toBe(false);
    lock.release();
    expect(spawn.mock.calls.length).toBe(callsAfterRelease);
  });

  it('a lock file replaced on disk is detected by dev+ino and the lock is re-taken on the file at the path (E5)', () => {
    const lockPath = tempLockPath();
    const lock = open(lockPath);
    fs.unlinkSync(lockPath); // 外部が消して作り直した (このモジュール自身は決して消さない)
    fs.writeFileSync(lockPath, '');
    expect(lock.tryLock('EX')).toMatchObject({ ok: true, held: 'EX' });
    expect(probeLock(lockPath, 'EX')).toBe('busy');
  });

  it('selfCheck passes on the local filesystem while holding EX or SH, and refuses while holding nothing', () => {
    const lockPath = tempLockPath();
    const lock = open(lockPath);
    expect(lock.selfCheck()).toEqual({ ok: false, outcome: 'not-locked' });
    lock.tryLock('EX');
    expect(lock.selfCheck()).toEqual({ ok: true, outcome: 'busy' });
    expect(probeLock(lockPath, 'EX')).toBe('busy'); // 2 つ目の記述を閉じても 1 つ目の lock は残る
    lock.tryLock('SH');
    expect(lock.selfCheck()).toEqual({ ok: true, outcome: 'busy' }); // verify は降格のあとに検査する (PR #872 指摘 1)
    expect(probeLock(lockPath, 'SH')).toBe('free');
  });

  it('only an EX holder writes the owner; garbage content does not affect locking', () => {
    const lockPath = tempLockPath();
    const lock = open(lockPath);
    const owner = { by: 'npm run verify', pid: 1, phase: 'verify', sha: null, cwd: '/x', at: 'T' };
    expect(lock.writeOwner(owner)).toBe(false);
    lock.tryLock('EX');
    expect(lock.writeOwner(owner)).toBe(true);
    expect(readOwner(lockPath)).toEqual(owner);
    lock.tryLock('SH');
    expect(lock.writeOwner({ by: 'other' })).toBe(false);
    expect(readOwner(lockPath)).toEqual(owner);
    lock.release();
    fs.writeFileSync(lockPath, '\u0000garbage{');
    expect(readOwner(lockPath)).toEqual({ unreadable: '\u0000garbage{' });
    expect(open(lockPath).tryLock('EX').ok).toBe(true);
  });

  it('a broken BDBOARD_FLOCK_HELPER gives an unsupported lock even though perl exists', () => {
    const lock = open(tempLockPath(), { env: { [FLOCK_HELPER_ENV]: '["/nonexistent/flock-helper"]' } });
    expect(lock.supported).toBe(false);
    expect(lock.reason).toContain('no flock helper');
  });

  it.skipIf(!pythonAvailable)('BDBOARD_FLOCK_HELPER selects the python3 helper and it locks the same way', () => {
    const lockPath = tempLockPath();
    const lock = open(lockPath, { env: { [FLOCK_HELPER_ENV]: JSON.stringify(PYTHON_FLOCK_HELPER) } });
    expect(lock.helper).toEqual(PYTHON_FLOCK_HELPER);
    expect(lock.tryLock('EX').ok).toBe(true);
    expect(probeLock(lockPath, 'SH')).toBe('busy');
    expect(lock.tryLock('SH').ok).toBe(true);
    expect([probeLock(lockPath, 'EX'), probeLock(lockPath, 'SH')]).toEqual(['busy', 'free']);
  });
});
