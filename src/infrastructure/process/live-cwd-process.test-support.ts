import { spawn } from 'node:child_process';
import { once } from 'node:events';

export interface LiveCwdProcess {
  readonly pid: number;
  stop(): Promise<void>;
}

/** Test-only process whose cwd can be observed by lsof. */
export async function startLiveCwdProcess(cwd: string): Promise<LiveCwdProcess> {
  const child = spawn('/bin/sleep', ['30'], {
    cwd,
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  await new Promise<void>((resolve) => setTimeout(resolve, 25));

  if (child.pid === undefined) {
    throw new Error('fixture process did not receive a pid');
  }

  return {
    pid: child.pid,
    async stop(): Promise<void> {
      if (child.exitCode !== null) {
        return;
      }
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    },
  };
}
