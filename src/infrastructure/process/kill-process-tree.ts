import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 子プロセスとその子孫を終了させる。戻り値は kill を発行できたか。
 *
 * POSIX: detached なプロセスグループ全体にシグナルを送る (bdboard-l1t.9)。
 * Windows: プロセスグループもシグナルも無く process.kill(-pid) は ESRCH になる
 * (bdboard-9dm)。taskkill /T でツリーごと強制終了する。コンソールアプリは WM_CLOSE を
 * 無視するため、SIGTERM 相当でも /F を付ける（推測: Node が起動する CLI はコンソール
 * サブシステム配下になりがち）。
 */
export function killProcessTree(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL',
): boolean {
  const pid = child.pid;
  if (pid === undefined) {
    return false;
  }

  if (process.platform === 'win32') {
    // Windows では signal を区別できない。コンソールアプリは WM_CLOSE を無視するため
    // SIGTERM 相当でも taskkill /F で強制終了する (bdboard-9dm)。
    const taskkill = spawn(
      'taskkill',
      ['/pid', String(pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );
    taskkill.on('error', () => {});
    return true;
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    return child.kill(signal);
  }
}
