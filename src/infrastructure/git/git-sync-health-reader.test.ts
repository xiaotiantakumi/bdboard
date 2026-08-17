import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import { createGitSyncHealthReader } from './git-sync-health-reader.js';

const ROOT = '/projects/test';

interface FakeRunnerOptions {
  readonly handler?: (
    command: string,
    args: readonly string[],
  ) => Promise<CommandResult> | CommandResult;
}

function createFakeRunner(options: FakeRunnerOptions = {}): {
  runner: CommandRunner;
  readonly calls: Array<{ command: string; args: readonly string[] }>;
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];

  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (options.handler) {
        return await options.handler(command, args);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

describe('createGitSyncHealthReader', () => {
  it('assembles healthy SyncHealthSignals from git and fs reads', async () => {
    const commitSeconds = 1_700_000_000;
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'rev-parse') {
          return { stdout: 'localhash\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'log') {
          return { stdout: `${commitSeconds}\n`, stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'remote') {
          return { stdout: 'origin\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'ls-remote') {
          return { stdout: 'remotehash\trefs/dolt/data\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'status') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });

    const fs: FileSystemPort = {
      readDir: async () => [],
      isDirectory: async () => false,
      realPath: async (p) => p,
      stat: async (p) => {
        if (p.endsWith('issues.jsonl')) {
          return { mtimeMs: commitSeconds * 1000, size: 100 };
        }
        return undefined;
      },
      readFile: async () => undefined,
      readRange: async () => undefined,
      readRangeBytes: async () => undefined,
    };

    const reader = createGitSyncHealthReader(runner, fs);
    const signals = await reader.readSignals(ROOT);

    expect(signals).toEqual({
      localDoltRefHash: 'localhash',
      localDoltRefCommitMs: commitSeconds * 1000,
      remoteDoltRefHash: 'remotehash',
      issuesJsonlMtimeMs: commitSeconds * 1000,
      interactionsUncommitted: false,
    });
  });

  it('returns null local hash when rev-parse fails and skips log/ls-remote', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'rev-parse') {
          return { stdout: '', stderr: 'fatal: bad ref', exitCode: 128 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const fs: FileSystemPort = {
      readDir: async () => [],
      isDirectory: async () => false,
      realPath: async (p) => p,
      stat: async () => undefined,
      readFile: async () => undefined,
      readRange: async () => undefined,
      readRangeBytes: async () => undefined,
    };

    const reader = createGitSyncHealthReader(runner, fs);
    const signals = await reader.readSignals(ROOT);

    expect(signals.localDoltRefHash).toBeNull();
    expect(signals.localDoltRefCommitMs).toBeNull();
    expect(signals.remoteDoltRefHash).toBeNull();

    const gitSubcommands = calls
      .flatMap((call) => call.args)
      .filter((arg, index, arr) => arr[index - 1] === ROOT);
    expect(gitSubcommands).not.toContain('log');
    expect(gitSubcommands).not.toContain('ls-remote');
  });

  it('returns null remote hash when remote list is empty', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'rev-parse') {
          return { stdout: 'localhash\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'log') {
          return { stdout: '1700000000\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'remote') {
          return { stdout: '\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'status') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const fs: FileSystemPort = {
      readDir: async () => [],
      isDirectory: async () => false,
      realPath: async (p) => p,
      stat: async () => undefined,
      readFile: async () => undefined,
      readRange: async () => undefined,
      readRangeBytes: async () => undefined,
    };

    const reader = createGitSyncHealthReader(runner, fs);
    const signals = await reader.readSignals(ROOT);

    expect(signals.remoteDoltRefHash).toBeNull();
  });

  it('detects uncommitted interactions from porcelain status output', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'rev-parse') {
          return { stdout: 'localhash\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'log') {
          return { stdout: '1700000000\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'remote') {
          return { stdout: 'origin\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'ls-remote') {
          return { stdout: 'localhash\trefs/dolt/data\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'status') {
          return { stdout: ' M .beads/interactions.jsonl\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const fs: FileSystemPort = {
      readDir: async () => [],
      isDirectory: async () => false,
      realPath: async (p) => p,
      stat: async () => undefined,
      readFile: async () => undefined,
      readRange: async () => undefined,
      readRangeBytes: async () => undefined,
    };

    const reader = createGitSyncHealthReader(runner, fs);
    const signals = await reader.readSignals(ROOT);

    expect(signals.interactionsUncommitted).toBe(true);
  });

  it('returns null issuesJsonlMtimeMs when stat is undefined', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'rev-parse') {
          return { stdout: 'localhash\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'log') {
          return { stdout: '1700000000\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'remote') {
          return { stdout: 'origin\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'ls-remote') {
          return { stdout: 'localhash\trefs/dolt/data\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'status') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const fs: FileSystemPort = {
      readDir: async () => [],
      isDirectory: async () => false,
      realPath: async (p) => p,
      stat: async () => undefined,
      readFile: async () => undefined,
      readRange: async () => undefined,
      readRangeBytes: async () => undefined,
    };

    const reader = createGitSyncHealthReader(runner, fs);
    const signals = await reader.readSignals(ROOT);

    expect(signals.issuesJsonlMtimeMs).toBeNull();
  });
});
