// bdboard-sso1.54: cloudflared-tunnel.ts の move-only 分割で切り出した spawn プロセス
// アダプタ関連。node:child_process の ChildProcess を SpawnedProcess インターフェース
// へ薄くラップする層。挙動は一切変えていない(移動のみ)。
import type { ChildProcess } from 'node:child_process';

export interface DataStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
}

export interface SpawnedProcess {
  readonly stdout: DataStream | null;
  readonly stderr: DataStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
) => SpawnedProcess;

export function asSpawnedProcess(child: ChildProcess): SpawnedProcess {
  const processHandle: SpawnedProcess = {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
    on: (event, listener) => {
      child.on(event, listener as never);
      return processHandle;
    },
  };
  return processHandle;
}
