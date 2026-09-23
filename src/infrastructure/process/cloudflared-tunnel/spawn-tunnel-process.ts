// bdboard-sso1.57: createCloudflaredTunnel() から切り出した spawn の関心。実行ファイルと
// ポートから cloudflared の起動引数を組み立て、spawnFn を呼び、結果を state.child へ登録する
// (outputBuffer もここでリセットする — 元のコードでも spawn 直前でのリセットだったため、
// 同じ位置に揃えた)。
import type { SpawnedProcess, SpawnFn } from './spawned-process.js';
import type { TunnelRuntimeState } from './runtime-state.js';

export function spawnTunnelProcess(
  state: TunnelRuntimeState,
  spawnFn: SpawnFn,
  executable: string,
  port: number,
): SpawnedProcess {
  state.outputBuffer = '';
  const processHandle = spawnFn(executable, [
    'tunnel',
    '--url',
    `http://127.0.0.1:${port}`,
  ]);
  state.child = processHandle;
  return processHandle;
}
