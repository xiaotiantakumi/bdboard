import type { CommandFailureKind } from './command-runner.js';

export interface ReclaimRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly failureKind?: CommandFailureKind;
}

export interface LeaseReclaimer {
  reclaim(projectRootPath: string, olderThan: string): Promise<ReclaimRunResult>;
}
