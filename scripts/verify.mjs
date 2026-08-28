#!/usr/bin/env node
// bdboard-kia: `npm run verify` のプロセスグループ管理ラッパー。
//
// 背景: エージェントの Bash ツールや subprocess の timeout で verify が打ち切られる
// とき、殺されるのは直系の子 (zsh → npm → sh) だけで、vitest コーディネータが
// tinypool で fork した孫ワーカーは道連れにならず PPID=1 で孤児化して残る
// (実測: 15分で16個、CPU 251% / RSS 7GB — bdboard-kia)。
//
// 対策: bdboard-6j2 の CommandRunner (src/infrastructure/process/node-command-runner.ts:
// spawn detached + process.kill(-pid)) と同じプロセスグループkillパターンを、
// 「開発者/エージェントが verify を起動する経路」に適用する。
//
// 構造 (dev=macOS / CI=Linux+Windows。kill 機構は POSIX がプロセスグループ、
// win32 が taskkill /T で、分岐は process-tree.mjs に集約してある — bdboard-6l7):
//
//   npm run verify
//     └─ node scripts/verify.mjs              … 外側。呼び出し元の直系(タイムアウトで殺される側)
//          └─ node scripts/verify.mjs --group-leader   [detached → 新プロセスグループ]
//               └─ npm run verify:steps → sh → tsc/vite/vitest(+ワーカー)  … 全員リーダーと同グループ
//
// - 外側が SIGTERM/SIGINT/SIGHUP を受けたら: リーダーのグループ全体に SIGTERM →
//   GRACE_MS 後に SIGKILL。verify の全プロセス(ワーカー含む)が確実に死ぬ。
// - 外側が SIGKILL 等で掃除なしに死んだ場合: リーダーが自分の孤児化を検知して
//   自グループごと SIGTERM → SIGKILL する(孤児化の恒久防止)。検知は POSIX が
//   PPID=1、win32 が「起動時に控えた親 PID の生存確認」(process-tree.mjs)。
// - どちらの監視も常時稼働サーバー(BDBOARD_PORT)や無関係な node には触れない
//   (対象は自分の作った新プロセスグループのみ)。
//
// bdboard-d48: さらに外側モードは、リーダー起動前にマシン単位の実行スロット
// (既定2、verify-slot.mjs) を獲得する。verify の同時実行本数の上限はここで効く。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { npmRunSpawnSpec } from './npm-command.mjs';
import { isOrphaned, killProcessTree } from './process-tree.mjs';
import { acquireVerifySlot, envSlotOptions, SlotWaitTimeoutError } from './verify-slot.mjs';

const GRACE_MS = 5_000;
const ORPHAN_POLL_MS = 1_000;
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 起動時の親 PID。win32 の孤児検知はこれの生存確認で行う (process-tree.mjs の isOrphaned)。
// 分岐前に採るので、外側モードでは呼び出し元シェル、リーダーモードでは外側の PID になる。
const INITIAL_PPID = process.ppid;

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGKILL: 137, SIGTERM: 143 };

if (process.argv.includes('--group-leader')) {
  // ---- リーダーモード: 新プロセスグループの先頭。verify 本体を同グループで走らせる ----
  const { command, args, options } = npmRunSpawnSpec('verify:steps');
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });

  // 後始末の根にする pid。
  //
  // POSIX は自分を含むプロセスグループ全体 (自分も道連れでよい) なので process.pid。
  // win32 は taskkill を spawn する方式なので自分の pid を根にすると、taskkill 自身が
  // リーダーの子 = /T の走査対象ツリーの中に入り、走査の途中で自分や親を殺してツリーの
  // 一部が生き残りうる (fable レビュー指摘, bdboard-6l7)。npm 子を根にすれば taskkill は
  // 対象ツリーの外に出る。リーダー自身は child の exit を受けて通常経路で終わるので
  // 掃除は完結するし、リーダーが刺さった場合は外側モードの
  // killProcessTree(leader.pid) が効く (あちらの taskkill は外側の子なので同じ問題を
  // 持たない)。
  const cleanupRootPid = () => (process.platform === 'win32' ? child.pid : process.pid);

  let killSequenceStarted = false;
  const ensureGroupDies = (sendTerm) => {
    if (killSequenceStarted) {
      return;
    }
    killSequenceStarted = true;
    const rootPid = cleanupRootPid();
    if (rootPid === undefined) {
      // win32 で npm の spawn 自体に失敗した場合。下の 'error' ハンドラが exit する。
      return;
    }
    if (sendTerm) {
      killProcessTree(rootPid, 'SIGTERM');
    }
    // 猶予後に SIGKILL(POSIX では自分も含む)。正常終了時は exit で消えるタイマー。
    setTimeout(() => killProcessTree(rootPid, 'SIGKILL'), GRACE_MS).unref();
  };

  // 外側からのグループ宛て SIGTERM で自分だけ先に死なない(猶予中の SIGKILL 番人を残す)。
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => ensureGroupDies(false));
  }

  // 外側が SIGKILL 等で掃除なしに消えたら、自グループを畳む。
  const orphanWatch = setInterval(() => {
    if (isOrphaned(INITIAL_PPID)) {
      ensureGroupDies(true);
    }
  }, ORPHAN_POLL_MS);

  child.on('exit', (code, signal) => {
    clearInterval(orphanWatch);
    if (killSequenceStarted) {
      // グループの後始末(SIGKILL タイマー)が走り切るのを待ってから消える。
      setTimeout(() => process.exit(SIGNAL_EXIT_CODES[signal] ?? code ?? 1), GRACE_MS + 500);
      return;
    }
    process.exit(signal !== null ? (SIGNAL_EXIT_CODES[signal] ?? 1) : (code ?? 1));
  });
  child.on('error', (error) => {
    console.error(`verify: failed to spawn npm: ${error.message}`);
    process.exit(1);
  });
} else {
  // ---- 外側モード: 実行スロットを獲得してから、リーダーを新プロセスグループ(detached)で起動する ----
  // スロット待機中のシグナルは「列から抜けて終了」(holder file は acquire 側の
  // exit フックが片付ける)。リーダー起動後は下の killLeaderGroup 系に役目を渡す。
  const waitPhaseHandlers = new Map();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const handler = () => process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
    waitPhaseHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  let slot;
  try {
    slot = await acquireVerifySlot(envSlotOptions());
  } catch (error) {
    if (error instanceof SlotWaitTimeoutError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const leader = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--group-leader'],
    {
      cwd: repoRoot,
      detached: true,
      stdio: 'inherit',
    },
  );

  let killSequenceStarted = false;
  const killLeaderGroup = () => {
    if (killSequenceStarted || leader.pid === undefined) {
      return;
    }
    killSequenceStarted = true;
    killProcessTree(leader.pid, 'SIGTERM');
    setTimeout(() => killProcessTree(leader.pid, 'SIGKILL'), GRACE_MS).unref();
  };

  // 待機フェーズ用ハンドラを外し、以後のシグナルはリーダーグループの後始末に回す。
  for (const [signal, handler] of waitPhaseHandlers) {
    process.removeListener(signal, handler);
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, killLeaderGroup);
  }

  // 直系の親(sh/npm/zsh)だけが殺されて自分が取り残された場合も、グループを畳んで従う。
  const orphanWatch = setInterval(() => {
    if (isOrphaned(INITIAL_PPID)) {
      killLeaderGroup();
    }
  }, ORPHAN_POLL_MS);

  leader.on('exit', (code, signal) => {
    clearInterval(orphanWatch);
    // グループ全体の SIGKILL 猶予を待つ経路でも、スロット自体は今すぐ返す。
    slot.release();
    process.exit(signal !== null ? (SIGNAL_EXIT_CODES[signal] ?? 1) : (code ?? 1));
  });
  leader.on('error', (error) => {
    console.error(`verify: failed to spawn group leader: ${error.message}`);
    process.exit(1);
  });
}
