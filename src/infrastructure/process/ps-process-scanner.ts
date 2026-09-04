import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import { parseHeartbeatLoopCommand } from '../../domain/heartbeat-loop.js';
import type {
  ProcessScanner,
  ScannedHeartbeatLoop,
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
  /** bd-heartbeat pidfile ディレクトリ。未指定時は ${TMPDIR}/bd-heartbeat.<uid> */
  readonly heartbeatStateDir?: string;
}

interface PsRow {
  readonly pid: number;
  readonly lstart: string;
  readonly command: string;
}

interface PsRawRow {
  readonly pid: number;
  readonly lstart: string;
  readonly commandLine: string;
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

const SHELL_BASENAMES = new Set(['bash', 'sh', 'zsh']);

function isHeartbeatLoopCommand(commandLine: string): boolean {
  const trimmed = commandLine.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (matchesAgentCommand(commandLine) !== undefined) {
    return false;
  }

  const firstBasename = tokenBasename(trimmed.split(/\s+/)[0] ?? '');
  if (!SHELL_BASENAMES.has(firstBasename)) {
    return false;
  }

  if (/bd-heartbeat(?:\.sh)?\s+(?:stop|status)\b/.test(commandLine)) {
    return false;
  }

  if (/bd-heartbeat(?:\.sh)?\s+start\b/.test(commandLine)) {
    return true;
  }

  const hasLoopKeyword = /\b(?:while|for|until)\b/.test(commandLine);
  const hasBdHeartbeat = /\bbd(?:\s+\S+)*\s+heartbeat\b/.test(commandLine);
  return hasLoopKeyword && hasBdHeartbeat;
}

function parseLstart(value: string): Date | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function parsePsRawLines(stdout: string): PsRawRow[] {
  const rows: PsRawRow[] = [];

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

    rows.push({
      pid,
      lstart: match[2],
      commandLine: match[3],
    });
  }

  return rows;
}

function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = [];

  for (const raw of parsePsRawLines(stdout)) {
    const command = matchesAgentCommand(raw.commandLine);
    if (command === undefined) {
      continue;
    }

    rows.push({
      pid: raw.pid,
      lstart: raw.lstart,
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

function defaultHeartbeatStateDir(): string {
  const tmpdir = process.env.TMPDIR || '/tmp';
  const uid = process.getuid?.();
  const uidToken = uid === undefined ? 'unknown' : String(uid);
  return `${tmpdir}/bd-heartbeat.${uidToken}`;
}

interface HeartbeatPidfileRecord {
  readonly sessionPid: number;
  readonly lstart: string | undefined;
}

async function readHeartbeatPidfileMap(
  stateDir: string,
): Promise<Map<number, HeartbeatPidfileRecord>> {
  const map = new Map<number, HeartbeatPidfileRecord>();

  try {
    const entries = await readdir(stateDir);
    for (const entry of entries) {
      if (!entry.endsWith('.pid')) {
        continue;
      }

      const sessionPid = Number.parseInt(entry.slice(0, -'.pid'.length), 10);
      if (!Number.isFinite(sessionPid)) {
        continue;
      }

      let content: string;
      try {
        content = await readFile(join(stateDir, entry), 'utf8');
      } catch {
        continue;
      }

      const firstLine = content.split('\n')[0] ?? '';
      const tabParts = firstLine.split('\t');
      const loopPidToken = tabParts[0]?.trim() ?? '';
      const loopPid = Number.parseInt(loopPidToken, 10);
      if (!Number.isFinite(loopPid) || loopPid <= 1) {
        continue;
      }

      const lstartRaw = tabParts.slice(1).join('\t').trim();
      map.set(loopPid, {
        sessionPid,
        lstart: lstartRaw.length > 0 ? lstartRaw : undefined,
      });
    }
  } catch {
    return map;
  }

  return map;
}

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
