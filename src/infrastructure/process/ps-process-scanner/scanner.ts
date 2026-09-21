import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { parseHeartbeatLoopCommand } from '../../../domain/heartbeat-loop.js';
import type {
  ProcessScanner,
  ScannedHeartbeatLoop,
  ScannedProcess,
} from '../../../application/ports/process-scanner.js';
import { defaultHeartbeatStateDir, readHeartbeatPidfileMap } from './heartbeat-pidfile.js';
import { isHeartbeatLoopCommand } from './heartbeat-loop-command.js';
import { parseLsofOutput } from './lsof-output.js';
import { parseLstart, parsePsOutput, parsePsRawLines } from './ps-output.js';
import type { PsProcessScannerOptions } from './types.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const PS_ARGS = ['-xo', 'pid=,lstart=,command='] as const;

export function createPsProcessScanner(
  commandRunner: CommandRunner,
  options?: PsProcessScannerOptions,
): ProcessScanner {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const heartbeatStateDir =
    options?.heartbeatStateDir ?? defaultHeartbeatStateDir();

  return {
    async listAgentProcesses(): Promise<readonly ScannedProcess[]> {
      const psResult = await commandRunner.run('ps', PS_ARGS, { timeoutMs });
      if (psResult.exitCode !== 0) {
        return [];
      }

      const rows = parsePsOutput(psResult.stdout);
      if (rows.length === 0) {
        return [];
      }

      const pidArg = rows.map((row) => row.pid).join(',');
      const lsofResult = await commandRunner.run(
        'lsof',
        ['-a', '-d', 'cwd', '-p', pidArg, '-Fpn'],
        { timeoutMs },
      );
      // lsof exits 1 whenever ANY requested pid is already gone, even when it
      // reported cwd for the surviving ones. Processes routinely exit between
      // the ps call and this call, so a non-zero exit is not a hard failure:
      // trust whatever it managed to print and only bail out when it printed
      // nothing usable.
      const cwdByPid = parseLsofOutput(lsofResult.stdout);
      if (lsofResult.exitCode !== 0 && cwdByPid.size === 0) {
        return [];
      }

      const results: ScannedProcess[] = [];

      for (const row of rows) {
        const cwd = cwdByPid.get(row.pid);
        if (cwd === undefined) {
          continue;
        }

        const startedAt = parseLstart(row.lstart);
        results.push({
          pid: row.pid,
          command: row.command,
          cwd,
          ...(startedAt !== undefined ? { startedAt } : {}),
        });
      }

      return results.sort((a, b) => a.pid - b.pid);
    },

    async listHeartbeatLoops(): Promise<readonly ScannedHeartbeatLoop[]> {
      const psResult = await commandRunner.run('ps', PS_ARGS, { timeoutMs });
      if (psResult.exitCode !== 0) {
        return [];
      }

      const rawRows = parsePsRawLines(psResult.stdout);
      const alivePids = new Set(rawRows.map((row) => row.pid));
      const pidfileMap = await readHeartbeatPidfileMap(heartbeatStateDir);

      const results: ScannedHeartbeatLoop[] = [];

      for (const row of rawRows) {
        if (!isHeartbeatLoopCommand(row.commandLine)) {
          continue;
        }

        const pidfileRecord = pidfileMap.get(row.pid);
        let sessionPid: number | undefined;
        let sessionAlive: boolean | undefined;

        if (
          pidfileRecord !== undefined
          && pidfileRecord.lstart !== undefined
          && pidfileRecord.lstart === row.lstart
        ) {
          sessionPid = pidfileRecord.sessionPid;
          sessionAlive = alivePids.has(sessionPid);
        } else {
          const parsed = parseHeartbeatLoopCommand(row.commandLine);
          if (parsed.sessionPidArg !== undefined) {
            sessionPid = parsed.sessionPidArg;
            sessionAlive = alivePids.has(sessionPid);
          }
        }

        const startedAt = parseLstart(row.lstart);

        results.push({
          pid: row.pid,
          commandLine: row.commandLine,
          ...(startedAt !== undefined ? { startedAt } : {}),
          lstart: row.lstart,
          ...(sessionPid !== undefined ? { sessionPid } : {}),
          ...(sessionAlive !== undefined ? { sessionAlive } : {}),
        });
      }

      return results.sort((a, b) => a.pid - b.pid);
    },
  };
}
