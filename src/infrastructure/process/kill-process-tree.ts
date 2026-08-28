import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 子プロセスとその子孫を終了させる。戻り値は kill を発行できたか。
 *
 * POSIX: detached なプロセスグループ全体にシグナルを送る (bdboard-l1t.9)。
 * Windows: プロセスグループもシグナルも無く process.kill(-pid) は ESRCH になる
 * (bdboard-9dm)。taskkill /T でツリーごと強制終了する。
 *
 * win32 で /F を外せない直接の理由は、呼び出し側の spawn が windowsHide: true
 * (CREATE_NO_WINDOW) だから: /F 無しの taskkill は WM_CLOSE を送るが、送り先の
 * コンソールウィンドウをそもそも作っていないので届かない。よって Windows では
 * SIGTERM 相当と SIGKILL 相当が同じ強制終了になり、streaming runner の
 * STOP_GRACE_MS エスカレーション (SIGTERM → 猶予 → SIGKILL) は Windows では
 * 構造としては動くが実質的な意味を持たない。
 *
 * 既知の非対称 (bdboard-dpm): POSIX のプロセスグループはリーダーが死んでも存続する
 * ので kill(-pid) は孤児化した孫にも届くが、taskkill /T は起動時点の親子連鎖を辿る
 * ため、直接の子が既に終了していると孫を殺し損ねる。完全にやるなら Job Object が要る。
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
    // taskkill の終了を待つ間イベントループを生かさない (shutdown 経路や
    // vitest ワーカーの終了を数十ms 遅らせるだけの意味しか無いため)。
    taskkill.unref();
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
