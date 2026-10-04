// bdboard-wea0.1: `npm run verify` (scripts/verify.mjs の外側) が worktree lock を取る手順。設計は
// `bd show bdboard-wea0` の DESIGN 欄 §4 の verify.mjs の行。lock 部品は scripts/worktree-lock.mjs。
//
// verify は worktree を SH で持つ (手動 verify 同士、merge-pr と自分の契約 verify は共有できる)。作業ツリーを
// 切り替える操作 (merge-pr の detach checkout と restore、wea0.2) は EX を取りに来るので、verify が生きている間は
// 切り替えられない。外側はこれをスロット待ちより前に取り、verify の間ずっと持つ (待っている間も使用中と示す)。
//
// 1. 空いていれば EX を取り、持ち主 {by:'npm run verify',...} を書いて SH に降格する。EX の間は書き込みと降格の
//    spawn 1 回だけにする (sha は EX の前に読み、自己検査は SH を持ってから行う。PR #872 レビュー指摘 1)。
// 2. 塞がっていれば中身を読む。merge-pr が持っていて (phase が done 以外)、その pid が BDBOARD_WORKTREE_HELD_BY
//    (merge-pr が自分の契約 verify に渡す、wea0.2) と違えば即拒否 (exit 1。gate bdboard-oiak 問1 の既定 A)。それ以外は
//    SH|NB で共有する。merge-pr と名乗らない誰かが EX を持っている (別の手動 verify が持ち主を書いて降格する間) なら、
//    持ち主を読み直しながら最大 SHARE_WAIT_MS 待ち (2 秒後と以後 10 秒ごとに 1 行)、過ぎたら 75 (= 走らせていない。
//    merge-pr は failure と読まない)。降格の拒否やヘルパーのエラーを「誰かが入った」と言わない (再レビュー N5)。
// 3. SH を取れたら必ず持ち主を読み直す。SH を持つ間は誰も EX を持てず、書くには EX が要るので、この読み直しは確定的
//    (読んでから SH を取るまでの隙間に merge-pr が入る TOCTOU を閉じる。レビュー指摘 2)。
// 4. ヘルパーが無い・git の外・自己検査の失敗・予期しない例外は lock 無しで走る (CI と他の開発者を lock で止めない)。
//    win32 は黙って、それ以外は stderr に 1 行。BDBOARD_WORKTREE_LOCK=off は使うたびに警告する (gate 問3 の既定 A)。
//
// verify.mjs の import graph に入るので、古い Node でもパースできる構文に保つ (verify.mjs 冒頭の bdboard-eu2k)。
import { spawnSync as nodeSpawnSync } from 'node:child_process';

import { SLOT_WAIT_TIMEOUT_EXIT_CODE } from './verify-slot.mjs';
import { lockPathFor, openWorktreeLock } from './worktree-lock.mjs';
import { describeOwner, lsofHint, readOwner } from './worktree-lock-owner.mjs';

export const WORKTREE_LOCK_ENV = 'BDBOARD_WORKTREE_LOCK';
// verify-slot.mjs の SLOT_IDENTITY_ENV にも入っている (リーダーに受け継がせない)。
export const WORKTREE_HELD_BY_ENV = 'BDBOARD_WORKTREE_HELD_BY';
export const VERIFY_OWNER_BY = 'npm run verify';
export const SHARE_WAIT_MS = 30_000;
const SHARE_POLL_MS = 100;
const SHARE_NOTICE_FIRST_MS = 2_000; // 待っていると知らせる 1 行: 2 秒後に 1 回、以後 10 秒ごと (スロット待ちと同じく「ハングではない」)
const SHARE_NOTICE_EVERY_MS = 10_000;
export const REFUSED_EXIT_CODE = 1;
// 待ちの打ち切りは verify を 1 つも走らせていないので、スロット待ちの打ち切りと同じ予約値 (75、EX_TEMPFAIL)。
export const SHARE_TIMEOUT_EXIT_CODE = SLOT_WAIT_TIMEOUT_EXIT_CODE;

// phase が done の merge-pr の行は、終わった merge-pr の残り書き。
const isActiveMergePr = (owner) => owner !== null && typeof owner.by === 'string' && owner.by.startsWith('merge-pr') && owner.phase !== 'done';

/** 塞がった worktree の持ち主が、この verify を拒否させる相手か。 */
export function ownerRefusesVerify(owner, heldBy) {
  if (!isActiveMergePr(owner)) {
    return false;
  }
  return heldBy === undefined || heldBy === '' || String(owner.pid) !== String(heldBy);
}

function refuse(ctx, owner, headline, exitCode) {
  releaseQuietly(ctx.lock);
  ctx.log(`verify: ${headline}; not running verify here (exit ${exitCode}).`);
  if (isActiveMergePr(owner)) {
    ctx.log('verify:   merge-pr switches this worktree (detached checkout, verify, restore) under the worktree lock; a verify started now could test or break the wrong tree.');
  }
  ctx.log(`verify:   wait for it to finish or run verify in another worktree. Who holds the lock now: ${lsofHint(ctx.lockPath)}`);
  return { lock: null, exitCode };
}

const refuseForMergePr = (ctx, owner) => refuse(ctx, owner, `this worktree is held by ${describeOwner(owner)} — a merge-pr owns it`, REFUSED_EXIT_CODE);

/** lock を閉じる。閉じられなくても投げない (verify.mjs のリーダー終了時も、verify の結果を変えないためにこれを使う)。 */
export function releaseQuietly(lock) {
  try {
    if (lock) {
      lock.release();
    }
  } catch {
    /* 閉じられなくても、もう使わない */
  }
}

function unlocked(ctx, line) {
  releaseQuietly(ctx.lock);
  if (line !== undefined) {
    ctx.log(`verify: worktree lock: ${line} — running WITHOUT the worktree lock (nothing stops merge-pr from switching this tree mid-run).`);
  }
  return { lock: null, exitCode: null };
}

/** SH を取れた直後: 持ち主を読み直し (確定的)、2 つ目の記述が塞がれることを確かめてから lock を渡す。 */
function confirmShared(ctx) {
  const owner = readOwner(ctx.lockPath);
  if (ownerRefusesVerify(owner, ctx.env[WORKTREE_HELD_BY_ENV])) {
    return refuseForMergePr(ctx, owner);
  }
  const check = ctx.lock.selfCheck();
  if (!check.ok) {
    return unlocked(ctx, `a second descriptor was not blocked (${check.outcome}); this filesystem does not keep flock locks`);
  }
  return { lock: ctx.lock, exitCode: null };
}

async function claim(ctx) {
  if (ctx.platform === 'win32') {
    return unlocked(ctx); // 設計 §5: Windows は対象外。何も spawn しない。
  }
  if (ctx.env[WORKTREE_LOCK_ENV] === 'off') {
    return unlocked(ctx, `${WORKTREE_LOCK_ENV}=off is set (emergency hatch, docs/VERIFY.md "Worktree lock")`);
  }
  const git = (args) => {
    const result = ctx.spawnSync('git', args, { cwd: ctx.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim() !== '' ? result.stdout.trim() : null;
  };
  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  if (gitDir === null) {
    return unlocked(ctx, `${ctx.repoRoot} is not a git worktree`);
  }
  ctx.lockPath = lockPathFor(gitDir);
  const sha = git(['rev-parse', 'HEAD']);
  try {
    ctx.lock = openWorktreeLock({ path: ctx.lockPath, env: ctx.env, platform: ctx.platform, spawnSync: ctx.spawnSync });
  } catch (error) {
    return unlocked(ctx, `cannot open ${ctx.lockPath} (${error.message})`);
  }
  if (!ctx.lock.supported) {
    return unlocked(ctx, ctx.lock.reason);
  }
  const failed = (result) => unlocked(ctx, `flock on ${ctx.lockPath} failed (${result.outcome})`);

  const exclusive = ctx.lock.tryLock('EX');
  if (exclusive.ok) {
    const owner = { by: VERIFY_OWNER_BY, pid: process.pid, phase: 'verify', sha, cwd: ctx.repoRoot, at: new Date(ctx.now()).toISOString() };
    if (!ctx.lock.writeOwner(owner)) {
      ctx.log(`verify: worktree lock: could not write the owner line to ${ctx.lockPath}; continuing (the line is advisory, the lock is held).`);
    }
    const shared = ctx.lock.tryLock('SH');
    if (shared.ok) {
      return confirmShared(ctx);
    }
    if (shared.outcome !== 'busy') {
      return failed(shared); // ヘルパーのエラー (打ち切りを含む) は「誰かが入った」ではない
    }
    ctx.log(`verify: worktree lock: the ${shared.converted} conversion was refused (busy): another holder took the lock in the gap. Re-checking its owner.`);
  } else if (exclusive.outcome !== 'busy') {
    return failed(exclusive);
  }

  const startedAt = ctx.now();
  let nextNotice = startedAt + SHARE_NOTICE_FIRST_MS;
  for (;;) {
    const owner = readOwner(ctx.lockPath);
    if (ownerRefusesVerify(owner, ctx.env[WORKTREE_HELD_BY_ENV])) {
      return refuseForMergePr(ctx, owner);
    }
    const shared = ctx.lock.tryLock('SH');
    if (shared.ok) {
      return confirmShared(ctx);
    }
    if (shared.outcome !== 'busy') {
      return failed(shared);
    }
    // 持ち主の行は最後に EX を取った者が書いたもので、いま EX を持っている者とは限らない (書く前・古い行)。
    const lastLine = `the last owner line says ${describeOwner(owner)}, which may be stale`;
    const now = ctx.now();
    if (now - startedAt >= SHARE_WAIT_MS) {
      return refuse(ctx, owner, `something has held the worktree lock exclusively for over ${SHARE_WAIT_MS} ms (${lastLine})`, SHARE_TIMEOUT_EXIT_CODE);
    }
    if (now >= nextNotice) {
      ctx.log(`verify: waiting to share the worktree lock (held exclusively; ${lastLine}; waited ${Math.round((now - startedAt) / 1000)}s of ${SHARE_WAIT_MS / 1000}s) — not a hang`);
      nextNotice = now + SHARE_NOTICE_EVERY_MS;
    }
    await ctx.sleep(SHARE_POLL_MS);
  }
}

/**
 * lock を取る。{ lock, exitCode } を返す: lock は持っている lock オブジェクト (fd をリーダーの fd 3 に渡す) か
 * lock 無しで走るときの null、exitCode は拒否したときの終了コード (走ってよければ null)。投げない。
 */
export async function claimWorktreeForVerify(options) {
  const ctx = {
    repoRoot: options.repoRoot,
    env: options.env || process.env,
    platform: options.platform || process.platform,
    spawnSync: options.spawnSync || nodeSpawnSync,
    log: options.log || ((line) => console.error(line)),
    sleep: options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: options.now || Date.now,
    lock: null,
    lockPath: null,
  };
  try {
    return await claim(ctx);
  } catch (error) {
    return unlocked(ctx, `unexpected error (${error && error.message ? error.message : String(error)})`);
  }
}
