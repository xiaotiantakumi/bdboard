// bdboard-wea0.1: verify.mjs が worktree lock を取る手順 (scripts/verify-worktree-claim.mjs) のうち、実プロセスの verify
// (verify-worktree-lock.test.mjs) では起こせない分岐を、注入で固定する: win32 で何も spawn しないこと、拒否の判定、
// EX→SH の降格が隙間で拒否されたときに黙らず報告して持ち主を確かめ直すこと (設計 E4)。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimWorktreeForVerify, ownerRefusesVerify, VERIFY_OWNER_BY } from './verify-worktree-claim.mjs';
import { readOwner } from './worktree-lock-owner.mjs';
import { probeLock, realProcessLockTestsSkipped } from './worktree-lock.test-support.mjs';

const tempDirs = [];
const claimedLocks = [];

afterEach(() => {
  claimedLocks.splice(0).forEach((lock) => lock.release());
  tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('claimWorktreeForVerify (injected)', () => {
  it('win32: runs unlocked and silent — no git, no helper, no stderr line', async () => {
    const spawn = vi.fn();
    const log = vi.fn();
    const claim = await claimWorktreeForVerify({ repoRoot: '/nonexistent-dir', platform: 'win32', spawnSync: spawn, log, env: {} });
    expect(claim).toEqual({ lock: null, exitCode: null });
    expect(spawn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('only an active merge-pr that is not BDBOARD_WORKTREE_HELD_BY refuses a verify', () => {
    const mergePr = { by: 'merge-pr finish 869', pid: 4242, phase: 'verify' };
    expect(ownerRefusesVerify(mergePr, undefined)).toBe(true);
    expect(ownerRefusesVerify(mergePr, '')).toBe(true);
    expect(ownerRefusesVerify(mergePr, '4243')).toBe(true);
    expect(ownerRefusesVerify(mergePr, '4242')).toBe(false);
    expect(ownerRefusesVerify({ ...mergePr, phase: 'done' }, undefined)).toBe(false); // 終わった merge-pr の残り書き
    expect(ownerRefusesVerify({ by: VERIFY_OWNER_BY, pid: 1, phase: 'verify' }, undefined)).toBe(false);
    expect(ownerRefusesVerify({ unreadable: 'garbage' }, undefined)).toBe(false);
    expect(ownerRefusesVerify(null, undefined)).toBe(false);
  });

  it.skipIf(realProcessLockTestsSkipped)('a refused EX->SH downgrade is reported and the owner re-checked, then SH is taken', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-worktree-claim-'));
    tempDirs.push(repoRoot);
    expect(spawnSync('git', ['init', '-q', repoRoot]).status).toBe(0);
    let refusals = 1;
    // 最初の SH|NB (5) だけ「塞がっている」と答える: 降格の隙間に他者が EX を取り、すぐ SH に降りた場合。
    const gappy = (command, args, options) => {
      if (args[args.length - 1] === '5' && refusals > 0) {
        refusals -= 1;
        return { status: 1 };
      }
      return spawnSync(command, args, options);
    };
    const log = vi.fn();
    const claim = await claimWorktreeForVerify({ repoRoot, env: {}, spawnSync: gappy, log, sleep: async () => {} });
    if (claim.lock !== null) {
      claimedLocks.push(claim.lock);
    }
    expect(claim.exitCode).toBe(null);
    expect(claim.lock.mode).toBe('SH');
    expect(log.mock.calls.map(([line]) => line).join('\n')).toContain('EX->SH conversion was refused');
    const lockPath = claim.lock.path;
    expect(readOwner(lockPath)).toMatchObject({ by: VERIFY_OWNER_BY, pid: process.pid, phase: 'verify' });
    expect([probeLock(lockPath, 'EX'), probeLock(lockPath, 'SH')]).toEqual(['busy', 'free']);
  });
});
