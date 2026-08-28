// bdboard-6l7: verify.mjs のプロセスツリー後始末を、POSIX とプラットフォーム分岐が
// 要る win32 の両方で成立させるためのヘルパー。
//
// src/infrastructure/process/kill-process-tree.ts と同じ問題・同じ対処だが、
// あちらは TypeScript で、こちらは .mjs から import される素の Node スクリプトなので
// 共有できない (npm-command.mjs と同じ事情)。挙動を変えるときは両方を見ること。
import { spawn } from 'node:child_process';

/**
 * pid を根とするプロセスツリーを終了させる。
 *
 * POSIX: 従来どおりプロセスグループ宛てに送る。ESRCH は「もう居ない」として無視し、
 * それ以外のエラーでのみ単発 kill にフォールバックする (移設前と逐語同じ分岐)。
 *
 * win32: プロセスグループもシグナルも無い。libuv の uv_kill (src/win/process.c) は
 * 負の pid をそのまま OpenProcess に渡し、負値が巨大な DWORD になって失敗するため
 * ERROR_INVALID_PARAMETER -> UV_ESRCH にマップされる。ESRCH は上で握りつぶされるので
 * 単発 kill のフォールバックにも入らず、従来はこの関数が丸ごと no-op だった。
 * taskkill /T でツリーごと落とす。
 *
 * Windows ではシグナルを区別できないため SIGTERM 相当でも /F を付ける。verify が
 * 起動するのは tsc/vite/vitest というコンソールアプリで、猶予付きの WM_CLOSE を
 * 期待できる相手ではない。
 *
 * 既知の限界 (bdboard-dpm と同じ): taskkill /T は起動時点の親子連鎖を辿るので、
 * 直接の子が先に終了していると孤児化した孫を殺し損ねる。完全にやるなら Job Object。
 */
export function killProcessTree(pid, signal, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const kill = deps.kill ?? ((targetPid, targetSignal) => process.kill(targetPid, targetSignal));

  if (platform === 'win32') {
    const spawnFn = deps.spawn ?? spawn;
    try {
      const taskkill = spawnFn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      taskkill.on('error', () => {});
      // taskkill の終了待ちでイベントループを生かさない。
      taskkill.unref?.();
    } catch {
      /* taskkill 自体を起動できなければ、ここでできることはもう無い */
    }
    return;
  }

  try {
    kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      try {
        kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * 「親が後始末をせずに消えた」= 自分が孤児化したかを判定する。
 *
 * POSIX: 親が死ぬと init/launchd に reparent されるので PPID === 1 で判る (従来の判定)。
 *
 * win32: reparent という概念が無く、親が死んでも PPID の値は変わらない (=1 にはならない。
 * そもそも Windows の PID は 4 の倍数なので 1 は実在しない)。代わりに、起動時に控えた
 * 親 PID がまだ生きているかを signal 0 で問い合わせる。EPERM は「居るが触れない」なので
 * 孤児ではない。PID 再利用で誤検知する理屈上の穴はあるが、verify 1 回の寿命の間に
 * 親の PID が再利用される確率は無視できる。
 */
export function isOrphaned(initialPpid, deps = {}) {
  const platform = deps.platform ?? process.platform;

  if (platform !== 'win32') {
    return (deps.currentPpid ?? process.ppid) === 1;
  }

  if (typeof initialPpid !== 'number' || initialPpid <= 0) {
    return false;
  }
  const kill = deps.kill ?? ((targetPid, targetSignal) => process.kill(targetPid, targetSignal));
  try {
    kill(initialPpid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}
