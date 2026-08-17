import path from 'node:path';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { SyncHealthReader } from '../../application/ports/sync-health-reader.js';
import type { SyncHealthSignals } from '../../domain/sync-health.js';

const DEFAULT_GIT_PATH = 'git';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GitSyncHealthReaderOptions {
  readonly gitPath?: string;
  readonly timeoutMs?: number;
}

async function runGit(
  commandRunner: CommandRunner,
  gitPath: string,
  rootPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return commandRunner.run(gitPath, ['-C', rootPath, ...args], { timeoutMs });
}

function parseLocalDoltRefHash(result: CommandResult): string | null {
  if (result.exitCode !== 0) {
    return null;
  }

  const hash = result.stdout.trim();
  return hash.length > 0 ? hash : null;
}

function parseCommitMs(result: CommandResult): number | null {
  if (result.exitCode !== 0) {
    return null;
  }

  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(seconds)) {
    return null;
  }

  return seconds * 1000;
}

function parseRemoteName(result: CommandResult): string | null {
  if (result.exitCode !== 0) {
    return null;
  }

  const names = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (names.length === 0) {
    return null;
  }

  if (names.includes('origin')) {
    return 'origin';
  }

  return names[0] ?? null;
}

function parseRemoteDoltRefHash(result: CommandResult): string | null {
  if (result.exitCode !== 0) {
    return null;
  }

  const firstLine = result.stdout.split('\n').find((line) => line.trim().length > 0);
  if (firstLine === undefined) {
    return null;
  }

  const hash = firstLine.trim().split(/\s+/)[0];
  return hash !== undefined && hash.length > 0 ? hash : null;
}

function parseInteractionsUncommitted(result: CommandResult): boolean {
  if (result.exitCode !== 0) {
    return false;
  }

  return result.stdout.trim().length > 0;
}

export function createGitSyncHealthReader(
  commandRunner: CommandRunner,
  fs: FileSystemPort,
  options?: GitSyncHealthReaderOptions,
): SyncHealthReader {
  const gitPath = options?.gitPath ?? DEFAULT_GIT_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async readSignals(rootPath: string): Promise<SyncHealthSignals> {
      const revParseResult = await runGit(
        commandRunner,
        gitPath,
        rootPath,
        ['rev-parse', '--verify', 'refs/dolt/data'],
        timeoutMs,
      );
      const localDoltRefHash = parseLocalDoltRefHash(revParseResult);

      const issuesJsonlPath = path.join(rootPath, '.beads', 'issues.jsonl');
      const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');

      const [localDoltRefCommitMs, remoteDoltRefHash, issuesStat, statusResult] =
        await Promise.all([
          (async (): Promise<number | null> => {
            if (localDoltRefHash === null) {
              return null;
            }

            const logResult = await runGit(
              commandRunner,
              gitPath,
              rootPath,
              ['log', '-1', '--format=%ct', 'refs/dolt/data'],
              timeoutMs,
            );
            return parseCommitMs(logResult);
          })(),
          (async (): Promise<string | null> => {
            if (localDoltRefHash === null) {
              return null;
            }

            const remoteResult = await runGit(
              commandRunner,
              gitPath,
              rootPath,
              ['remote'],
              timeoutMs,
            );
            const remoteName = parseRemoteName(remoteResult);
            if (remoteName === null) {
              return null;
            }

            const lsRemoteResult = await runGit(
              commandRunner,
              gitPath,
              rootPath,
              ['ls-remote', remoteName, 'refs/dolt/data'],
              timeoutMs,
            );
            return parseRemoteDoltRefHash(lsRemoteResult);
          })(),
          fs.stat(issuesJsonlPath),
          runGit(
            commandRunner,
            gitPath,
            rootPath,
            ['status', '--porcelain', '--', interactionsPath],
            timeoutMs,
          ),
        ]);

      return {
        localDoltRefHash,
        localDoltRefCommitMs,
        remoteDoltRefHash,
        issuesJsonlMtimeMs: issuesStat?.mtimeMs ?? null,
        interactionsUncommitted: parseInteractionsUncommitted(statusResult),
      };
    },
  };
}
