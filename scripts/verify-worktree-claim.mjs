// bdboard-wea0.1: `npm run verify` (scripts/verify.mjs の外側) が worktree lock を取る手順。設計は
// `bd show bdboard-wea0` の DESIGN 欄 §4 の verify.mjs の行。lock 部品は scripts/worktree-lock.mjs。
//
// verify は worktree を SH で持つ (手動 verify 同士、merge-pr と自分の契約 verify は共有できる)。作業ツリーを
// 切り替える操作 (merge-pr の detach checkout と restore、wea0.2) は EX を取りに来るので、verify が生きている間は
// 切り替えられない。外側はこれをスロット待ちより前に取り、verify の間ずっと持つ (待っている間も使用中と示す)。
//
// 1. 空いていれば EX を取り、持ち主 {by:'npm run verify',...} を書いて SH に降格する。降格の拒否 (E4) は報告して 2 へ。
// 2. 塞がっていれば中身を読む。merge-pr が持っていて (phase が done 以外)、その pid が BDBOARD_WORKTREE_HELD_BY
//    (merge-pr が自分の契約 verify に渡す) と違えば即拒否 (exit 1。gate bdboard-oiak 問1 の既定 A)。それ以外は SH|NB
//    で共有する。誰かが一瞬 EX を持っている (別の手動 verify が持ち主を書いている間) なら最大 SHARE_WAIT_MS 待つ。
// 3. ヘルパーが無い・git の外・win32・BDBOARD_WORKTREE_LOCK=off は lock 無しで走る (CI と他の開発者を lock で止めない)。
//    win32 以外は stderr に 1 行出す。off は使うたびに警告する (gate bdboard-oiak 問3 の既定 A)。
//
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つ (verify.mjs 冒頭の bdboard-eu2k)。
import { spawnSync as nodeSpawnSync } from 'node:child_process';

import { lockPathFor, openWorktreeLock } from './worktree-lock.mjs';
import { describeOwner, lsofHint, readOwner } from './worktree-lock-owner.mjs';

export const WORKTREE_LOCK_ENV = 'BDBOARD_WORKTREE_LOCK';
// verify-slot.mjs の SLOT_IDENTITY_ENV にも入っている (リーダーに受け継がせない)。
export const WORKTREE_HELD_BY_ENV = 'BDBOARD_WORKTREE_HELD_BY';
export const VERIFY_OWNER_BY = 'npm run verify';
export const SHARE_WAIT_MS = 2_000;
const SHARE_POLL_MS = 100;
const REFUSED_EXIT_CODE = 1;

/** 塞がった worktree の持ち主が、この verify を拒否させる相手か。 */
export function ownerRefusesVerify(owner, heldBy) {
  if (owner === null || typeof owner.by !== 'string' || !owner.by.startsWith('merge-pr') || owner.phase === 'done') {
    return false;
  }
  return heldBy === undefined || heldBy === '' || String(owner.pid) !== String(heldBy);
}

function refuse(log, owner, lockPath, why) {
  log(`verify: this worktree is held by ${describeOwner(owner)} — ${why}; not running verify here (exit ${REFUSED_EXIT_CODE}).`);
  log('verify:   merge-pr switches this worktree (detached checkout, verify, restore) under the worktree lock; a verify started now could test or break the wrong tree.');
  log(`verify:   wait for it to finish or run verify in another worktree. Who holds the lock now: ${lsofHint(lockPath)}`);
  return { lock: null, exitCode: REFUSED_EXIT_CODE };
}

/**
 * lock を取る。{ lock, exitCode } を返す: lock は持っている lock オブジェクト (fd をリーダーの fd 3 に渡す) か
 * lock 無しで走るときの null、exitCode は拒否したときの終了コード (走ってよければ null)。
 */
export async function claimWorktreeForVerify(options) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const spawnSync = options.spawnSync || nodeSpawnSync;
  const log = options.log || ((line) => console.error(line));
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const unlocked = (line) => {
    if (line !== undefined) {
      log(`verify: worktree lock: ${line} — running WITHOUT the worktree lock (nothing stops merge-pr from switching this tree mid-run).`);
    }
    return { lock: null, exitCode: null };
  };
  if (platform === 'win32') {
    return unlocked(); // 設計 §5: Windows は対象外。何も spawn しない。
  }
  if (env[WORKTREE_LOCK_ENV] === 'off') {
    return unlocked(`${WORKTREE_LOCK_ENV}=off is set (emergency hatch, docs/VERIFY.md "Worktree lock")`);
  }
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: options.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim() !== '' ? result.stdout.trim() : null;
  };
  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  if (gitDir === null) {
    return unlocked(`${options.repoRoot} is not a git worktree`);
  }
  const lockPath = lockPathFor(gitDir);
  let lock;
  try {
    lock = openWorktreeLock({ path: lockPath, env, platform, spawnSync });
  } catch (error) {
    return unlocked(`cannot open ${lockPath} (${error.message})`);
  }
  if (!lock.supported) {
    return unlocked(lock.reason);
  }
  const failed = (result) => {
    lock.release();
    return unlocked(`flock on ${lockPath} failed (${result.outcome})`);
  };

  const exclusive = lock.tryLock('EX');
  if (exclusive.ok) {
    const check = lock.selfCheck();
    if (!check.ok) {
      lock.release();
      return unlocked(`a second descriptor was not blocked (${check.outcome}); this filesystem does not keep flock locks`);
    }
    lock.writeOwner({ by: VERIFY_OWNER_BY, pid: process.pid, phase: 'verify', sha: git(['rev-parse', 'HEAD']), cwd: options.repoRoot, at: new Date(now()).toISOString() });
    const shared = lock.tryLock('SH');
    if (shared.ok) {
      return { lock, exitCode: null };
    }
    log(`verify: worktree lock: the ${shared.converted} conversion was refused (${shared.outcome}); another process took the lock in the gap. Re-checking its owner.`);
  } else if (exclusive.outcome !== 'busy') {
    return failed(exclusive);
  }

  const deadline = now() + SHARE_WAIT_MS;
  for (;;) {
    const owner = readOwner(lockPath);
    if (ownerRefusesVerify(owner, env[WORKTREE_HELD_BY_ENV])) {
      lock.release();
      return refuse(log, owner, lockPath, 'a merge-pr owns it');
    }
    const shared = lock.tryLock('SH');
    if (shared.ok) {
      return { lock, exitCode: null };
    }
    if (shared.outcome !== 'busy') {
      return failed(shared);
    }
    if (now() >= deadline) {
      lock.release();
      return refuse(log, owner, lockPath, `something has held the lock exclusively for over ${SHARE_WAIT_MS} ms`);
    }
    await sleep(SHARE_POLL_MS);
  }
}
