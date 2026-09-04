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

describe('createGitWorktreeScanner.listChangedFiles', () => {
  const HEAD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const MERGE_BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  interface FakeState {
    headSha: string;
    indexMtimeMs: number | undefined;
    diff: string;
    status: string;
    mergeBaseOkRefs: readonly string[];
  }

  function createScannerHarness(overrides: Partial<FakeState> = {}) {
    const state: FakeState = {
      headSha: HEAD_SHA,
      indexMtimeMs: 1000,
      diff: '',
      status: '',
      mergeBaseOkRefs: ['origin/main'],
      ...overrides,
    };

    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        // ['--no-optional-locks', '-C', <path>, <subcommand>, ...]
        expect(args[0]).toBe('--no-optional-locks');
        expect(args[1]).toBe('-C');
        const sub = args[3];
        if (sub === 'rev-parse') {
          return {
            stdout: `${state.headSha}\n/git/worktrees/wt/index\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (sub === 'merge-base') {
          const ref = args[4]!;
          return state.mergeBaseOkRefs.includes(ref)
            ? { stdout: `${MERGE_BASE}\n`, stderr: '', exitCode: 0 }
            : { stdout: '', stderr: 'fatal: Not a valid object name', exitCode: 128 };
        }
        if (sub === 'diff') {
          return { stdout: state.diff, stderr: '', exitCode: 0 };
        }
        if (sub === 'status') {
          return { stdout: state.status, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });

    const fs = {
      readDir: async () => [],
      isDirectory: async () => true,
      realPath: async (path: string) => path,
      stat: async () =>
        state.indexMtimeMs === undefined
          ? undefined
          : { mtimeMs: state.indexMtimeMs, size: 0 },
      readFile: async () => undefined,
      readRange: async () => undefined,
      readRangeBytes: async () => undefined,
    };

    return { state, calls, scanner: createGitWorktreeScanner(runner, { fs }) };
  }

  it('merges committed diff, uncommitted changes and untracked files', async () => {
    const { scanner } = createScannerHarness({
      diff: 'src/a.ts\0src/hygiene.ts\0',
      status: ' M src/hygiene.ts\0?? src/new.ts\0',
    });

    const files = await scanner.listChangedFiles('/wt');

    expect(files).toEqual(['src/a.ts', 'src/hygiene.ts', 'src/new.ts']);
  });

  it('picks up both sides of a rename from -z status output', async () => {
    const { scanner } = createScannerHarness({
      status: 'R  src/new-name.ts\0src/old-name.ts\0 M src/other.ts\0',
    });

    const files = await scanner.listChangedFiles('/wt');

    expect(files).toEqual(['src/new-name.ts', 'src/old-name.ts', 'src/other.ts']);
  });

  it('reuses the cache while HEAD sha and index mtime are unchanged', async () => {
    const { scanner, calls, state } = createScannerHarness({ diff: 'src/a.ts\0' });

    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts']);
    const afterFirst = calls.length;

    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts']);
    // 2 回目は rev-parse だけ。merge-base / diff / status は走らない
    expect(calls.length).toBe(afterFirst + 1);

    state.indexMtimeMs = 2000;
    state.diff = 'src/a.ts\0src/b.ts\0';
    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(calls.length).toBeGreaterThan(afterFirst + 2);
  });

  it('invalidates the cache when HEAD moves even if the index is untouched', async () => {
    const { scanner, state } = createScannerHarness({ diff: 'src/a.ts\0' });

    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts']);

    state.headSha = 'cccccccccccccccccccccccccccccccccccccccc';
    state.diff = 'src/c.ts\0';
    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/c.ts']);
  });

  it('does not cache when the index mtime cannot be read', async () => {
    const { scanner, calls } = createScannerHarness({
      indexMtimeMs: undefined,
      diff: 'src/a.ts\0',
    });

    await scanner.listChangedFiles('/wt');
    const afterFirst = calls.length;
    await scanner.listChangedFiles('/wt');

    expect(calls.length).toBe(afterFirst * 2);
  });

  it('falls back to the next merge-base ref when origin/main is absent', async () => {
    const { scanner, calls } = createScannerHarness({
      mergeBaseOkRefs: ['main'],
      diff: 'src/a.ts\0',
    });

    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts']);
    const mergeBaseRefs = calls
      .filter((call) => call.args[3] === 'merge-base')
      .map((call) => call.args[4]);
    expect(mergeBaseRefs).toEqual(['origin/main', 'origin/master', 'main']);
  });

  it('throws when no merge-base candidate resolves', async () => {
    const { scanner } = createScannerHarness({ mergeBaseOkRefs: [] });

    await expect(scanner.listChangedFiles('/wt')).rejects.toThrow(/merge-base/);
  });

  it('never invokes a write-side git subcommand', async () => {
    const { scanner, calls } = createScannerHarness({
      diff: 'src/a.ts\0',
      status: ' M src/a.ts\0',
    });

    await scanner.listChangedFiles('/wt');

    const WRITE_SUBCOMMANDS = [
      'checkout',
      'switch',
      'reset',
      'clean',
      'stash',
      'commit',
      'fetch',
      'pull',
      'push',
      'restore',
      'apply',
    ];
    for (const call of calls) {
      assertNoDestructiveGitArgs(call.args);
      for (const arg of call.args) {
        expect(WRITE_SUBCOMMANDS).not.toContain(arg);
      }
    }
  });
});
