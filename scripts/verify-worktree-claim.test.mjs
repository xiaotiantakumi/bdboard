// bdboard-wea0.1: verify.mjs が worktree lock を取る手順 (scripts/verify-worktree-claim.mjs) のうち、実プロセスの verify
// (verify-worktree-lock.test.mjs) では起こせない分岐を、注入で固定する: win32 で何も spawn しないこと、拒否の判定、
// 降格の拒否の報告 (E4)、自己検査の失敗、待っている間に merge-pr と名乗った持ち主、読んでから SH を取るまでの隙間
// (PR #872 レビュー指摘 2)、待ちの打ち切り (75)、予期しない例外。相手の lock はテストのプロセス自身が持つ。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimWorktreeForVerify, ownerRefusesVerify, SHARE_TIMEOUT_EXIT_CODE, VERIFY_OWNER_BY } from './verify-worktree-claim.mjs';
import { readOwner } from './worktree-lock-owner.mjs';
import { openWorktreeLock } from './worktree-lock.mjs';
import { probeLock, realProcessLockTestsSkipped } from './worktree-lock.test-support.mjs';

const tempDirs = [];
const openLocks = [];
const MERGE_PR = { by: 'merge-pr finish 869', pid: 4242, phase: 'verify', sha: 'abc', cwd: '/x', at: 'T' };

afterEach(() => {
  openLocks.splice(0).forEach((lock) => lock.release());
  tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

/** git init 済みの一時 repo と、その lock を持つ「相手」(テストのプロセス内の別の記述)。 */
const makeRepo = () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-worktree-claim-'));
  tempDirs.push(repoRoot);
  expect(spawnSync('git', ['init', '-q', repoRoot]).status).toBe(0);
  const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  const lockPath = path.join(gitDir, 'bdboard-worktree.lock');
  const other = () => {
    const lock = openWorktreeLock({ path: lockPath, env: {} });
    openLocks.push(lock);
    return lock;
  };
  return { repoRoot, lockPath, other };
};

/** 注入した時計: sleep のたびに進む (30 秒の待ちを実時間で待たない)。step を渡せば 1 回でその分跳ぶ (ヘルパーの spawn を減らす)。 */
const fakeClock = (onSleep = () => {}, step = undefined) => {
  let clock = 0;
  return { now: () => clock, sleep: async (ms) => { clock += step === undefined ? ms : step; onSleep(); } };
};

const runClaim = async (repoRoot, options = {}) => {
  const log = vi.fn();
  const claim = await claimWorktreeForVerify({ repoRoot, env: {}, log, sleep: async () => {}, ...options });
  if (claim.lock !== null) {
    openLocks.push(claim.lock);
  }
  return { claim, lines: log.mock.calls.map(([line]) => line) };
};

describe('claimWorktreeForVerify (injected)', () => {
  it('win32: runs unlocked and silent — no git, no helper, no stderr line', async () => {
    const spawn = vi.fn();
    const { claim, lines } = await runClaim('/nonexistent-dir', { platform: 'win32', spawnSync: spawn });
    expect(claim).toEqual({ lock: null, exitCode: null });
    expect(spawn).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('only an active merge-pr that is not BDBOARD_WORKTREE_HELD_BY refuses a verify', () => {
    expect(ownerRefusesVerify(MERGE_PR, undefined)).toBe(true);
    expect(ownerRefusesVerify(MERGE_PR, '')).toBe(true);
    expect(ownerRefusesVerify(MERGE_PR, '4243')).toBe(true);
    expect(ownerRefusesVerify(MERGE_PR, '4242')).toBe(false);
    expect(ownerRefusesVerify({ ...MERGE_PR, phase: 'done' }, undefined)).toBe(false); // 終わった merge-pr の残り書き
    expect(ownerRefusesVerify({ by: VERIFY_OWNER_BY, pid: 1, phase: 'verify' }, undefined)).toBe(false);
    expect(ownerRefusesVerify({ unreadable: 'garbage' }, undefined)).toBe(false);
    expect(ownerRefusesVerify(null, undefined)).toBe(false);
  });
});

describe.skipIf(realProcessLockTestsSkipped)('claimWorktreeForVerify against a real lock', { timeout: 20_000 }, () => {
  it('a refused EX->SH downgrade is reported and the owner re-checked, then SH is taken', async () => {
    const { repoRoot, lockPath } = makeRepo();
    let refusals = 1; // 最初の SH|NB (5) だけ「塞がっている」: 降格の隙間に他者が EX を取り、すぐ SH に降りた場合
    const gappy = (command, args, options) => (args[args.length - 1] === '5' && refusals-- > 0 ? { status: 1 } : spawnSync(command, args, options));
    const { claim, lines } = await runClaim(repoRoot, { spawnSync: gappy });
    expect(claim.exitCode).toBe(null);
    expect(claim.lock.mode).toBe('SH');
    expect(lines.join('\n')).toContain('EX->SH conversion was refused (busy): another holder took the lock in the gap');
    expect(readOwner(lockPath)).toMatchObject({ by: VERIFY_OWNER_BY, pid: process.pid, phase: 'verify' });
    expect([probeLock(lockPath, 'EX'), probeLock(lockPath, 'SH')]).toEqual(['busy', 'free']);
  });

  it('a helper error on the EX->SH downgrade is not blamed on another holder: one line, running unlocked', async () => {
    const { repoRoot, lockPath } = makeRepo();
    const erring = (command, args, options) => (args[args.length - 1] === '5' ? { error: new Error('ETIMEDOUT'), status: null } : spawnSync(command, args, options));
    const { claim, lines } = await runClaim(repoRoot, { spawnSync: erring });
    expect(claim).toEqual({ lock: null, exitCode: null });
    expect(lines).toEqual([expect.stringContaining('failed (error) — running WITHOUT the worktree lock')]);
    expect(probeLock(lockPath, 'EX')).toBe('free');
  });

  it('a self-check that finds a second descriptor free means one stderr line and running unlocked', async () => {
    const { repoRoot, lockPath } = makeRepo();
    let exclusiveCalls = 0; // EX|NB (6) の 2 回目 = 降格のあとの自己検査に「取れた」と答える (lock を保てない FS)
    const leaky = (command, args, options) => (args[args.length - 1] === '6' && ++exclusiveCalls === 2 ? { status: 0 } : spawnSync(command, args, options));
    const { claim, lines } = await runClaim(repoRoot, { spawnSync: leaky });
    expect(claim).toEqual({ lock: null, exitCode: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('does not keep flock locks');
    expect(probeLock(lockPath, 'EX')).toBe('free');
  });

  it('an EX holder that labels itself a merge-pr during the wait is refused (owner re-read on every try)', async () => {
    const { repoRoot, lockPath, other } = makeRepo();
    const mergePr = other();
    expect(mergePr.tryLock('EX').ok).toBe(true); // 持ち主はまだ書いていない (EX を取った直後)
    const clock = fakeClock(() => mergePr.writeOwner(MERGE_PR));
    const { claim, lines } = await runClaim(repoRoot, clock);
    expect(claim).toEqual({ lock: null, exitCode: 1 });
    expect(lines[0]).toContain('a merge-pr owns it');
    expect(probeLock(lockPath, 'SH')).toBe('busy'); // 相手の EX はそのまま
  });

  it('a merge-pr that writes its owner and downgrades between the read and our SH is still refused (TOCTOU)', async () => {
    const { repoRoot, lockPath, other } = makeRepo();
    fs.writeFileSync(lockPath, `${JSON.stringify({ by: VERIFY_OWNER_BY, pid: 1, phase: 'verify', at: 'stale' })}\n`);
    const mergePr = other();
    expect(mergePr.tryLock('EX').ok).toBe(true);
    let fired = false;
    const racing = (command, args, options) => {
      if (!fired && args[args.length - 1] === '5') {
        fired = true; // verify が古い持ち主を読んだあと、SH を取る直前に merge-pr が書いて降格する
        mergePr.writeOwner(MERGE_PR);
        expect(mergePr.tryLock('SH').ok).toBe(true);
      }
      return spawnSync(command, args, options);
    };
    const { claim, lines } = await runClaim(repoRoot, { spawnSync: racing });
    expect(fired).toBe(true);
    expect(claim).toEqual({ lock: null, exitCode: 1 });
    expect(lines.join('\n')).toContain('merge-pr finish 869 (pid 4242, phase verify');
    mergePr.release();
    expect(probeLock(lockPath, 'EX')).toBe('free'); // 自分の SH も手放している (拒否で lock を漏らさない。再レビュー N3)
  });

  it('an EX holder that is not an active merge-pr past the share wait gives 75 ("did not run"), with progress lines and no merge-pr wording', async () => {
    const { repoRoot, other } = makeRepo();
    const stuck = other();
    expect(stuck.tryLock('EX').ok).toBe(true);
    stuck.writeOwner({ ...MERGE_PR, phase: 'done' }); // 終わった merge-pr の残り書き: 拒否もしないし merge-pr の説明も出さない
    const { claim, lines } = await runClaim(repoRoot, fakeClock(undefined, 2_000)); // 2 秒ずつ跳ぶ時計 (spawn は約 15 回)
    expect(SHARE_TIMEOUT_EXIT_CODE).toBe(75);
    expect(claim).toEqual({ lock: null, exitCode: 75 });
    const notices = lines.filter((line) => line.includes('waiting to share the worktree lock'));
    expect(notices.map((line) => line.match(/waited (\d+)s of 30s/)[1])).toEqual(['2', '12', '22']); // 2 秒後、以後 10 秒ごと
    expect(lines[notices.length]).toContain('something has held the worktree lock exclusively for over 30000 ms (the last owner line says merge-pr');
    expect(lines.join('\n')).not.toContain('merge-pr switches');
  });

  it('a helper error on the first EX (e.g. the 10 s helper timeout) runs unlocked with one line', async () => {
    const { repoRoot, lockPath } = makeRepo();
    const stuck = (command, args, options) => (args[args.length - 1] === '6' ? { error: new Error('ETIMEDOUT'), status: null } : spawnSync(command, args, options));
    const { claim, lines } = await runClaim(repoRoot, { spawnSync: stuck });
    expect(claim).toEqual({ lock: null, exitCode: null });
    expect(lines).toEqual([expect.stringContaining('failed (error) — running WITHOUT the worktree lock')]);
    expect(probeLock(lockPath, 'EX')).toBe('free');
  });

  it('an unexpected throw after the lock was opened releases it and runs unlocked with one line', async () => {
    const { repoRoot, lockPath } = makeRepo();
    const throwing = (command, args, options) => {
      if (args[args.length - 1] === '5') {
        throw new Error('EMFILE: too many open files');
      }
      return spawnSync(command, args, options);
    };
    const { claim, lines } = await runClaim(repoRoot, { spawnSync: throwing });
    expect(claim).toEqual({ lock: null, exitCode: null });
    expect(lines).toEqual([expect.stringContaining('unexpected error (EMFILE')]);
    expect(probeLock(lockPath, 'EX')).toBe('free');
  });
});
