// bdboard-sso1.57: createCloudflaredTunnel() から切り出した kill の関心。SIGTERM を送り、
// stopGraceMs 以内に close/error が来なければ SIGKILL へ昇格する非同期版 (stop) と、次の
// start() の頭で古いプロセスを即座に切り離すためだけの同期版 (stopExistingSynchronously) の
// 2つ。どちらも渡された TunnelRuntimeState を直接書き換える — 元の
// createCloudflaredTunnel() 内クロージャがそうしていたのと同じ意味論(挙動は変えていない)。
import type { TunnelRuntimeState } from './runtime-state.js';

export async function stopTunnelProcess(
  state: TunnelRuntimeState,
  stopGraceMs: number,
): Promise<void> {
  const current = state.child;
  if (current === null) {
    return;
  }

  state.child = null;
  state.outputBuffer = '';

  if (!current.kill('SIGTERM')) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(forceKillTimer);
      resolve();
    };

    const forceKillTimer = setTimeout(() => {
      current.kill('SIGKILL');
      finish();
    }, stopGraceMs);

    current.on('close', () => {
      finish();
    });

    current.on('error', () => {
      finish();
    });
  });
}

export function stopTunnelProcessSynchronously(state: TunnelRuntimeState): void {
  const current = state.child;
  if (current === null) {
    return;
  }

  state.child = null;
  state.outputBuffer = '';
  current.kill('SIGTERM');
}
