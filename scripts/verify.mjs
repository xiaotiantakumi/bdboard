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
// 構造 (POSIX 前提。dev=macOS / CI=Linux。win32 は非対応):
//
//   npm run verify
//     └─ node scripts/verify.mjs              … 外側。呼び出し元の直系(タイムアウトで殺される側)
//          └─ node scripts/verify.mjs --group-leader   [detached → 新プロセスグループ]
//               └─ npm run verify:steps → sh → tsc/vite/vitest(+ワーカー)  … 全員リーダーと同グループ
//
// - 外側が SIGTERM/SIGINT/SIGHUP を受けたら: リーダーのグループ全体に SIGTERM →
//   GRACE_MS 後に SIGKILL。verify の全プロセス(ワーカー含む)が確実に死ぬ。
// - 外側が SIGKILL 等で掃除なしに死んだ場合: リーダーが自分の PPID=1 化を検知して
//   自グループごと SIGTERM → SIGKILL する(孤児化の恒久防止)。
// - どちらの監視も常時稼働サーバー(BDBOARD_PORT)や無関係な node には触れない
//   (対象は自分の作った新プロセスグループのみ)。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GRACE_MS = 5_000;
const ORPHAN_POLL_MS = 1_000;
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// node-command-runner.ts の killGroup と同じ: グループ宛てに送り、ESRCH は無視する。
function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }
}

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGKILL: 137, SIGTERM: 143 };

if (process.argv.includes('--group-leader')) {
  // ---- リーダーモード: 新プロセスグループの先頭。verify 本体を同グループで走らせる ----
  const child = spawn('npm', ['run', 'verify:steps'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  let killSequenceStarted = false;
  const ensureGroupDies = (sendTerm) => {
    if (killSequenceStarted) {
      return;
    }
    killSequenceStarted = true;
    if (sendTerm) {
      killGroup(process.pid, 'SIGTERM');
    }
    // 猶予後に自グループごと SIGKILL(自分も含む)。正常終了時は exit で消えるタイマー。
    setTimeout(() => killGroup(process.pid, 'SIGKILL'), GRACE_MS).unref();
  };

  // 外側からのグループ宛て SIGTERM で自分だけ先に死なない(猶予中の SIGKILL 番人を残す)。
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => ensureGroupDies(false));
  }

  // 外側が SIGKILL 等で掃除なしに消えたら、自グループを畳む。
  const orphanWatch = setInterval(() => {
    if (process.ppid === 1) {
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
  // ---- 外側モード: リーダーを新プロセスグループ(detached)で起動し、シグナルを中継する ----
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
    killGroup(leader.pid, 'SIGTERM');
    setTimeout(() => killGroup(leader.pid, 'SIGKILL'), GRACE_MS).unref();
  };

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, killLeaderGroup);
  }

  // 直系の親(sh/npm/zsh)だけが殺されて自分が取り残された場合も、グループを畳んで従う。
  const orphanWatch = setInterval(() => {
    if (process.ppid === 1) {
      killLeaderGroup();
    }
  }, ORPHAN_POLL_MS);

  leader.on('exit', (code, signal) => {
    clearInterval(orphanWatch);
    process.exit(signal !== null ? (SIGNAL_EXIT_CODES[signal] ?? 1) : (code ?? 1));
  });
  leader.on('error', (error) => {
    console.error(`verify: failed to spawn group leader: ${error.message}`);
    process.exit(1);
  });
}
