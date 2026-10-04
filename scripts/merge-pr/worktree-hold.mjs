// bdboard-wea0.2: merge-pr が worktree lock (scripts/worktree-lock.mjs、bdboard-wea0.1) を持つ部分。設計は
// `bd show bdboard-wea0` の DESIGN 欄 §3 (自己検査) と §4 (runLandedVerify / prepare / finish / 中断時の restore)。
// これが「どの verify がこの worktree を使っているか」を PID・開始時刻・年齢から推測していた記録 (verifying-record /
// verify-guard / predicted-guard) の置き換え: 使用中かどうかはカーネルの flock が答え、持ち主の行は案内にだけ使う。
//
// 1 プロセスに 1 つの hold (1 記述子。worktree-lock.mjs の決まり)。holdWorktree は冪等で、EX|NB が取れなければ
// 持ち主の行と `lsof -t` の行を出して 75 で止める。merge-pr は持ち主の行を、detach の前と SH への降格の前に必ず書く
// (書けなければ致命的: 降格した後に verify.mjs が拒否の判断に使うのはこの行だけ。#872 レビューの契約 1・2)。
// 'done' の行の間は降格しない (verify.mjs は done を「終わった merge-pr」と読んで共有してしまう。契約 3)。
// verify の後に EX へ戻して restore する部分は worktree-restore.mjs。
import { rmSync } from 'node:fs';
import path from 'node:path';

import { lockPathFor, openWorktreeLock } from '../worktree-lock.mjs';
import { describeOwner, lsofHint, readOwner } from '../worktree-lock-owner.mjs';
import { EXIT, fail } from './context.mjs';
import { run } from './exec.mjs';
import { say, stateDir } from './state.mjs';

export const OWNER_PREFIX = 'merge-pr';

let current = null;

export const isMergePr = (owner) => owner !== null && typeof owner.by === 'string' && owner.by.startsWith(OWNER_PREFIX);
export const isOurs = (owner) => isMergePr(owner) && String(owner.pid) === String(process.pid);

/** 75 で止めるときの行: 持ち主 (助言) と、推測の要らない「今持っているプロセス」のコマンド。 */
export function busyLines(lockPath, what) {
  return [
    `この worktree は worktree lock で使用中なので${what}: ${describeOwner(readOwner(lockPath))}。`,
    `  今 lock を持っているプロセス: ${lsofHint(lockPath)} (持ち主の行は最後に EX を取った者が書いた助言で、古いことがある)`,
    '  その verify / merge-pr が終わるのを待ってから同じコマンドをやり直してください。lock のファイルは消さないでください (消すと 2 人目が同時に取れる)。',
  ];
}

/** linked worktree (git worktree add で作ったもの) か。main checkout は git-dir = common-dir。 */
export function isLinkedWorktree(root) {
  const dirs = run('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: root });
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n');
  return dirs.status === 0 && gitDir !== commonDir;
}

// #876 レビュー N1: main checkout で lock を取ると、そこに merge-pr の行が残り、常時稼働サーバーの deploy --verify
// (main checkout の npm run verify) が拒否される。手順 (docs/GIT-WORKFLOW.md) どおり PR の worktree でだけ動く。
function refuseMainCheckout(ctx) {
  if (!isLinkedWorktree(ctx.cwd)) {
    fail(EXIT.USAGE, 'merge-pr は PR の worktree (git worktree add で作った作業ツリー) で実行します。main checkout の worktree lock は取らないので、ここでは進みません。', 'PR の worktree に移ってやり直してください。');
  }
}

function openLock(ctx) {
  const dir = run('git', ['rev-parse', '--absolute-git-dir'], { cwd: ctx.cwd });
  if (dir.status !== 0) {
    fail(EXIT.USAGE, `git-dir を読めないので worktree lock を取れません: ${dir.stderr.trim()}`);
  }
  const lockPath = lockPathFor(dir.stdout.trim());
  let lock;
  try {
    lock = openWorktreeLock({ path: lockPath });
  } catch (error) {
    fail(EXIT.USAGE, `worktree lock (${lockPath}) を開けません: ${error.message}`);
  }
  if (!lock.supported && process.platform !== 'win32') {
    fail(EXIT.USAGE, `worktree lock を使えないので merge-pr は動きません: ${lock.reason}。perl か python3 を入れるか、BDBOARD_FLOCK_HELPER を設定してください。`);
  }
  if (!lock.supported) {
    say(`注意: ${lock.reason}。Windows は worktree lock の対象外なので、lock 無しで続けます (docs/GIT-WORKFLOW.md「worktree lock」)。`);
  }
  return lock;
}

function takeExclusive(lock, what) {
  const got = lock.tryLock('EX');
  if (!got.ok) {
    fail(got.outcome === 'busy' ? EXIT.RETRY : EXIT.USAGE, ...(got.outcome === 'busy' ? busyLines(lock.path, what) : [`worktree lock (${lock.path}) を取れませんでした (${got.outcome})。`]));
  }
}

/** 最初の EX の後に 1 回: 新しい記述からの EX|NB が塞がることを確かめる (NFS 等の偽の lock の検出、設計 §3)。 */
function selfCheck(lock) {
  const check = lock.selfCheck();
  if (!check.ok) {
    lock.release();
    fail(EXIT.USAGE, `worktree lock の自己検査に失敗しました: 2 つ目の記述からの EX|NB が塞がりませんでした (${check.outcome})。このファイルシステムは flock を保持しないので merge-pr は動きません。`);
  }
}

/** 持ち主の行を書く。EX を持っていなければ書けない。fatal なら書けないことを致命的として止める。 */
export function setPhase(hold, phase, { fatal = true } = {}) {
  if (!hold.lock.supported) {
    return;
  }
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: hold.cwd });
  const line = { by: hold.by, pid: process.pid, phase, sha: head.stdout.trim(), cwd: hold.cwd, at: new Date().toISOString() };
  if (hold.lock.writeOwner(line)) {
    hold.phase = phase;
    return;
  }
  const why = `worktree lock (${hold.path}) に持ち主の行 (phase ${phase}) を書けませんでした (EX を持っていない、または書き込みの失敗)`;
  if (fatal) {
    fail(EXIT.USAGE, `${why}。持ち主の行が無いと手動の verify がこの木を使ってよいと読むので、進みません。`);
  }
  say(`注意: ${why}。続けます。`);
}

// 終わるときに EX を持っていれば持ち主の行を done にする (exit の直後に EX|NB に負けて SH を取った verify が、終わった
// merge-pr の古い行を読んで拒否しないように)。SH のまま終わる (verify の途中で落ちた) ときは書けないし、書かない。
function markDoneOnExit() {
  try {
    if (current !== null && current.lock.supported && current.lock.mode === 'EX' && current.phase !== 'done') {
      setPhase(current, 'done', { fatal: false });
    }
  } catch {
    /* 終わり際なので何もしない (行は助言) */
  }
}

/**
 * この worktree を EX で持つ (プロセス内で冪等)。塞がっていれば 75。ctx.lockBy は持ち主の行の by
 * (cli.mjs が 'merge-pr <phase> <対象>' を入れる)。
 */
export function holdWorktree(ctx) {
  if (current !== null && (!current.lock.supported || current.lock.mode === 'EX')) {
    return current;
  }
  if (current === null || current.lock.fd === null) {
    refuseMainCheckout(ctx);
    if (current === null) {
      process.once('exit', markDoneOnExit);
    }
    current = { lock: openLock(ctx), cwd: ctx.cwd, by: ctx.lockBy ?? OWNER_PREFIX, phase: null, checked: false, lost: false };
    current.path = current.lock.path;
  }
  if (!current.lock.supported) {
    return current;
  }
  takeExclusive(current.lock, '進みません');
  if (!current.checked) {
    selfCheck(current.lock);
    current.checked = true;
  }
  setPhase(current, 'held');
  return current;
}

/** prepare --dry-run: EX|NB を試してすぐ離す (読むだけの実行で手動の verify を待たせない)。塞がっていれば 75。 */
function probeWorktree(ctx) {
  if (current !== null) {
    return;
  }
  refuseMainCheckout(ctx);
  const lock = openLock(ctx);
  try {
    if (lock.supported) {
      takeExclusive(lock, '分類も表示しません');
      selfCheck(lock);
    }
  } finally {
    lock.release();
  }
}

/**
 * prepare の入口。--dry-run は probeWorktree、それ以外は EX を持ち続け、旧コード (bdboard-h2fk) の prepare が残した
 * 記録 pr-<N>-predicted-verify.json を消す (lock の下では意味が無い)。
 */
export function holdForPrepare(ctx, pr, dryRun) {
  if (dryRun) {
    probeWorktree(ctx);
    return;
  }
  holdWorktree(ctx);
  rmSync(path.join(stateDir(ctx.cwd), `pr-${pr}-predicted-verify.json`), { force: true });
}

/** 契約の verify の間: 持ち主の行 (phase verify) を書いてから SH へ降格する。拒否なら 75 (この木は戻さない)。 */
export function downgradeForVerify(hold) {
  if (!hold.lock.supported) {
    return;
  }
  setPhase(hold, 'verify');
  if (hold.phase !== 'verify') {
    fail(EXIT.USAGE, `持ち主の行が phase ${hold.phase} のままなので SH へ降格しません (done の行のまま降格すると手動の verify が共有してしまう)。`);
  }
  const shared = hold.lock.tryLock('SH');
  if (!shared.ok) {
    hold.lost = true;
    fail(
      shared.outcome === 'busy' ? EXIT.RETRY : EXIT.USAGE,
      `worktree lock の EX→SH が拒否されました (${shared.outcome})。その隙に別の保持者が入ったので、作業ツリーは戻しません (detach したまま): ${describeOwner(readOwner(hold.path))}。`,
      `  今 lock を持っているプロセス: ${lsofHint(hold.path)}。空になってから git checkout で PR のブランチに戻し、やり直してください。`,
    );
  }
}

/** 契約の verify を走らせてよいか (#872 再レビュー b)。走らせてよければ null、だめなら理由。 */
export function contractVerifyBlocker(hold) {
  if (!hold.lock.supported) {
    return null;
  }
  if (hold.lost || hold.lock.mode !== 'SH') {
    return `merge-pr が worktree lock を SH で持っていません (${hold.lock.mode ?? 'なし'})`;
  }
  const owner = readOwner(hold.path);
  return isOurs(owner) && owner.phase === 'verify' ? null : `持ち主の行がこの merge-pr の verify ではありません (${describeOwner(owner)})`;
}

/** contract verify / npm ci の子に fd 3 として渡す lock の記述 (無ければ空)。 */
export const lockFds = (hold) => (hold.lock.supported && hold.lock.fd !== null ? [hold.lock.fd] : []);
