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
    // **空 = 残骸なし、ではない。** これを取り違えると reclaim が生存セッションの
    // チケットを奪う (bdboard-6aci)。読めなかったことをスナップショットに載せる。
    expect(snapshot.complete).toBe(false);
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
    expect(snapshot.complete).toBe(false);
  });

  // CommandRunner は timeout / spawn 失敗を throw せず failureKind 付きで resolve する。
  // exitCode だけ見ていると timeout が exitCode 0 として通ることがあるので両方見る。
  it('reports an incomplete scan when git times out', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'worktree') {
          return { stdout: '', stderr: '', exitCode: 0, failureKind: 'timeout' as const };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const scanner = createGitWorktreeScanner(runner);
    const snapshot = await scanner.scan(ROOT);

    expect(snapshot.complete).toBe(false);
  });

  it('reports a complete scan when both git calls succeed', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[0] === '-C' && args[2] === 'worktree') {
          return { stdout: PORCELAIN_OUTPUT, stderr: '', exitCode: 0 };
        }
        return { stdout: 'bd/bdboard-3tw.94\n', stderr: '', exitCode: 0 };
      },
    });

    const scanner = createGitWorktreeScanner(runner);
    const snapshot = await scanner.scan(ROOT);

    expect(snapshot.complete).toBe(true);
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
    mergeBase: string;
    diff: string;
    status: string;
    mergeBaseOkRefs: readonly string[];
  }

  function createScannerHarness(overrides: Partial<FakeState> = {}) {
    const state: FakeState = {
      headSha: HEAD_SHA,
      mergeBase: MERGE_BASE,
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
          return { stdout: `${state.headSha}\n`, stderr: '', exitCode: 0 };
        }
        if (sub === 'merge-base') {
          const ref = args[4]!;
          return state.mergeBaseOkRefs.includes(ref)
            ? { stdout: `${state.mergeBase}\n`, stderr: '', exitCode: 0 }
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

    return { state, calls, scanner: createGitWorktreeScanner(runner) };
  }

  function subcommandsOf(calls: readonly { args: readonly string[] }[]): string[] {
    return calls.map((call) => call.args[3]!);
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

  it('asks git for every untracked file, not the folded directory form', async () => {
    const { scanner, calls } = createScannerHarness({});

    await scanner.listChangedFiles('/wt');

    const statusCall = calls.find((call) => call.args[3] === 'status')!;
    // 既定 (normal) だと未追跡ディレクトリが '?? newdir/' に畳まれ、中のファイルが
    // 重複判定に載らない
    expect(statusCall.args).toContain('--untracked-files=all');
  });

  it('caches the committed diff while HEAD and merge-base are unchanged', async () => {
    const { scanner, calls, state } = createScannerHarness({ diff: 'src/a.ts\0' });

    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts']);
    calls.length = 0;

    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts']);
    // 2 回目に diff は走らない (rev-parse / merge-base / status だけ)
    expect(subcommandsOf(calls)).not.toContain('diff');
    expect(state.diff).toBe('src/a.ts\0');
  });

  it('still sees working-tree edits on a repeat call with no commit in between', async () => {
    // 退行の再現: キャッシュを「HEAD + index の mtime」で持っていたときは、
    // --no-optional-locks で index が書き戻されないせいで編集も未追跡追加も
    // 検出できなくなっていた。作業ツリー側は毎回読むこと。
    const { scanner, calls, state } = createScannerHarness({ diff: 'src/a.ts\0' });

    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts']);

    state.status = ' M src/edited.ts\0?? src/brand-new.ts\0';
    expect(await scanner.listChangedFiles('/wt')).toEqual([
      'src/a.ts',
      'src/brand-new.ts',
      'src/edited.ts',
    ]);
    expect(subcommandsOf(calls).filter((sub) => sub === 'status')).toHaveLength(2);
  });

  it('invalidates the committed diff when HEAD moves', async () => {
    const { scanner, state } = createScannerHarness({ diff: 'src/a.ts\0' });

    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts']);

    state.headSha = 'cccccccccccccccccccccccccccccccccccccccc';
    state.diff = 'src/c.ts\0';
    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/c.ts']);
  });

  it('invalidates the committed diff when the merge-base moves', async () => {
    // 他セッションの fetch で origin/main が進むと、HEAD が同じでも差分は変わる
    const { scanner, state } = createScannerHarness({ diff: 'src/a.ts\0' });

    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts']);

    state.mergeBase = 'dddddddddddddddddddddddddddddddddddddddd';
    state.diff = 'src/a.ts\0src/b.ts\0';
    expect(await scanner.listChangedFiles('/wt')).toEqual(['src/a.ts', 'src/b.ts']);
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

  it('does not leave the status promise unhandled when diff rejects', async () => {
    // diff を await している間に status が reject すると、誰も待たない Promise が
    // 残って unhandled rejection になる (Node v15 以降は既定でプロセスが落ちる)。
    // status は diff より後に落ちるようにして、その順序を再現する。
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        const sub = args[3];
        if (sub === 'rev-parse') {
          return { stdout: `${HEAD_SHA}\n`, stderr: '', exitCode: 0 };
        }
        if (sub === 'merge-base') {
          return args[4] === 'origin/main'
            ? { stdout: `${MERGE_BASE}\n`, stderr: '', exitCode: 0 }
            : { stdout: '', stderr: '', exitCode: 128 };
        }
        if (sub === 'diff') {
          throw new Error('diff exploded');
        }
        if (sub === 'status') {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error('status exploded');
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });
    const scanner = createGitWorktreeScanner(runner);

    // 呼び出し側には diff の失敗が伝わる
    await expect(scanner.listChangedFiles('/wt')).rejects.toThrow('diff exploded');

    // status が落ちきるまで待つ。ハンドラが無ければここで unhandled rejection になり、
    // vitest がこのテストを失敗させる。
    await new Promise((resolve) => setTimeout(resolve, 60));
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
