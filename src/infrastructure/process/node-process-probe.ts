import type { ProcessProbe } from '../../application/ports/process-probe.js';

function getErrorCode(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return error.code;
  }
  return undefined;
}

export class NodeProcessProbe implements ProcessProbe {
  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'EPERM') {
        return true;
      }
      return false;
    }
  }
}
