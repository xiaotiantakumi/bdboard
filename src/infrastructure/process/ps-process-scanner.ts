import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  ProcessScanner,
  ScannedProcess,
} from '../../application/ports/process-scanner.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const PS_ARGS = ['-xo', 'pid=,lstart=,command='] as const;

const AGENT_COMMAND_BASENAMES = new Set([
  'claude',
  'claude.exe',
  'cursor-agent',
  'codex',
  'agy',
  'gemini',
]);

export interface PsProcessScannerOptions {
  readonly timeoutMs?: number;
}

interface PsRow {
  readonly pid: number;
  readonly lstart: string;
  readonly command: string;
}

function tokenBasename(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const lastSlash = Math.max(
    trimmed.lastIndexOf('/'),
    trimmed.lastIndexOf('\\'),
  );
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

function matchesAgentCommand(commandLine: string): string | undefined {
  if (commandLine.includes('/Applications/')) {
    return undefined;
  }

  for (const token of commandLine.split(/\s+/)) {
    const basename = tokenBasename(token);
    if (basename.length === 0 || basename === 'node') {
      continue;
    }

    if (AGENT_COMMAND_BASENAMES.has(basename)) {
      return basename;
    }
  }

  return undefined;
}

function parseLstart(value: string): Date | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const match = trimmed.match(
      /^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\d{4})\s+(.*)$/,
    );
    if (match === null) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    if (!Number.isFinite(pid)) {
      continue;
    }

    const command = matchesAgentCommand(match[3]);
    if (command === undefined) {
      continue;
    }

    rows.push({
      pid,
      lstart: match[2],
      command,
    });
  }

  return rows;
}

function parseLsofOutput(stdout: string): Map<number, string> {
  const map = new Map<number, string>();
  let currentPid: number | undefined;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      currentPid = Number.parseInt(line.slice(1), 10);
      continue;
    }

    if (line.startsWith('n') && currentPid !== undefined) {
      map.set(currentPid, line.slice(1));
      currentPid = undefined;
    }
  }

  return map;
}

export function createPsProcessScanner(
  commandRunner: CommandRunner,
  options?: PsProcessScannerOptions,
): ProcessScanner {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
  };
}
