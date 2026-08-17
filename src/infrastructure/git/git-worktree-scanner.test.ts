import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { createGitWorktreeScanner } from './git-worktree-scanner.js';

const ROOT = '/Users/example/repo';

const PORCELAIN_OUTPUT = `worktree /Users/example/repo
HEAD 34417f554c4d8b1f487f9c672a1a43f95c3888a7
branch refs/heads/main

worktree /Users/example/repo/.claude/worktrees/bdboard-3tw.94
HEAD 34417f554c4d8b1f487f9c672a1a43f95c3888a7
branch refs/heads/bd/bdboard-3tw.94

worktree /Users/example/my repo/detached one
HEAD 34417f554c4d8b1f487f9c672a1a43f95c3888a7
detached

`;

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

const DESTRUCTIVE_GIT_ARGS = ['remove', '-d', '-D', 'prune'] as const;

function assertNoDestructiveGitArgs(args: readonly string[]): void {
  for (const arg of args) {
    expect(DESTRUCTIVE_GIT_ARGS).not.toContain(arg);
  }
}

describe('createGitWorktreeScanner', () => {
  it('parses porcelain worktree output and bd branches', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'worktree') {
          return { stdout: PORCELAIN_OUTPUT, stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'branch') {
          return {
            stdout: 'bd/bdboard-3tw.94\nbd/bdboard-3tw.96\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });

    const scanner = createGitWorktreeScanner(runner);
    const snapshot = await scanner.scan(ROOT);

    expect(snapshot.worktrees).toEqual([
      {
        path: '/Users/example/repo',
        branch: 'main',
        isMain: true,
      },
      {
        path: '/Users/example/repo/.claude/worktrees/bdboard-3tw.94',
        branch: 'bd/bdboard-3tw.94',
        isMain: false,
      },
      {
        path: '/Users/example/my repo/detached one',
        branch: null,
        isMain: false,
      },
    ]);
    expect(snapshot.bdBranches).toEqual(['bd/bdboard-3tw.94', 'bd/bdboard-3tw.96']);

    for (const call of calls) {
      assertNoDestructiveGitArgs(call.args);
    }
  });

  it('returns empty worktrees when worktree list fails', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'worktree') {
          return { stdout: '', stderr: 'fatal', exitCode: 128 };
        }
        if (args[0] === '-C' && args[2] === 'branch') {
          return { stdout: 'bd/bdboard-3tw.94\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });

    const scanner = createGitWorktreeScanner(runner);
    const snapshot = await scanner.scan(ROOT);

    expect(snapshot.worktrees).toEqual([]);
    expect(snapshot.bdBranches).toEqual(['bd/bdboard-3tw.94']);
  });

  it('returns empty bdBranches when branch list fails', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'worktree') {
          return { stdout: PORCELAIN_OUTPUT, stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'branch') {
          return { stdout: '', stderr: 'fatal', exitCode: 128 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });

    const scanner = createGitWorktreeScanner(runner);
    const snapshot = await scanner.scan(ROOT);

    expect(snapshot.worktrees).toHaveLength(3);
    expect(snapshot.bdBranches).toEqual([]);
  });

  it('lets a bare repo block consume the main slot so linked worktrees stay candidates', async () => {
    const bareOutput = `worktree /Users/example/bare.git
bare

worktree /Users/example/worktrees/bdboard-3tw.94
HEAD 34417f554c4d8b1f487f9c672a1a43f95c3888a7
branch refs/heads/bd/bdboard-3tw.94
`;

    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'worktree') {
          return { stdout: bareOutput, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const scanner = createGitWorktreeScanner(runner);
    const snapshot = await scanner.scan(ROOT);

    expect(snapshot.worktrees).toEqual([
      {
        path: '/Users/example/worktrees/bdboard-3tw.94',
        branch: 'bd/bdboard-3tw.94',
        isMain: false,
      },
    ]);
  });

  it('never invokes destructive git subcommands', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'worktree') {
          return { stdout: PORCELAIN_OUTPUT, stderr: '', exitCode: 0 };
        }
        if (args[0] === '-C' && args[2] === 'branch') {
          return { stdout: 'bd/bdboard-3tw.94\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });

    const scanner = createGitWorktreeScanner(runner);
    await scanner.scan(ROOT);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      assertNoDestructiveGitArgs(call.args);
    }
    expect(calls.some((call) => call.args.includes('worktree'))).toBe(true);
    expect(calls.some((call) => call.args.includes('branch'))).toBe(true);
  });
});
