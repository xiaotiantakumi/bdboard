import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { createBdCliDependencyWriter } from './bd-cli-dependency-writer.js';

const ROOT = '/root/proj';
const ISSUE_ID = 'bdboard-3tw.42';
const DEPENDS_ON_ID = 'bdboard-3tw.41';

interface FakeRunnerOptions {
  readonly handler?: (
    command: string,
    args: readonly string[],
    options?: { cwd?: string },
  ) => Promise<CommandResult> | CommandResult;
}

function createFakeRunner(options: FakeRunnerOptions = {}): {
  runner: CommandRunner;
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: { cwd?: string };
  }>;
} {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options?: { cwd?: string };
  }> = [];

  const runner: CommandRunner = {
    async run(command, args, runOptions) {
      calls.push({ command, args, options: runOptions });
      if (options.handler) {
        return await options.handler(command, args, runOptions);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

describe('createBdCliDependencyWriter', () => {
  it('adds dependency via bd_dep_add args', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliDependencyWriter(runner);

    await port.addDependency(ROOT, ISSUE_ID, DEPENDS_ON_ID);

    expect(calls).toEqual([
      {
        command: 'bd',
        args: ['-C', ROOT, 'dep', 'add', ISSUE_ID, DEPENDS_ON_ID],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
    ]);
  });

  it('removes dependency via bd_dep_remove args', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliDependencyWriter(runner);

    await port.removeDependency(ROOT, ISSUE_ID, DEPENDS_ON_ID);

    expect(calls).toEqual([
      {
        command: 'bd',
        args: ['-C', ROOT, 'dep', 'remove', ISSUE_ID, DEPENDS_ON_ID],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
    ]);
  });

  it('throws BdError with bd stderr detail when add exits non-zero', async () => {
    const circularMessage =
      'error: would create circular dependency: bdboard-3tw.42 -> bdboard-3tw.41';
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: circularMessage,
        exitCode: 1,
      }),
    });
    const port = createBdCliDependencyWriter(runner);

    await expect(
      port.addDependency(ROOT, ISSUE_ID, DEPENDS_ON_ID),
    ).rejects.toMatchObject({
      detail: circularMessage.toLowerCase(),
    });
  });

  it('throws BdError with bd stderr detail when remove exits non-zero', async () => {
    const stderr = 'dependency not found';
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr,
        exitCode: 1,
      }),
    });
    const port = createBdCliDependencyWriter(runner);

    await expect(
      port.removeDependency(ROOT, ISSUE_ID, DEPENDS_ON_ID),
    ).rejects.toMatchObject({
      detail: stderr,
    });
  });

  it('throws BdError when buildBdToolArgs rejects invalid issue id', async () => {
    const { runner } = createFakeRunner();
    const port = createBdCliDependencyWriter(runner);

    await expect(
      port.addDependency(ROOT, '-rf', DEPENDS_ON_ID),
    ).rejects.toBeInstanceOf(BdError);
  });

  it('throws BdError when buildBdToolArgs rejects invalid dependsOnId', async () => {
    const { runner } = createFakeRunner();
    const port = createBdCliDependencyWriter(runner);

    await expect(
      port.removeDependency(ROOT, ISSUE_ID, '-rf'),
    ).rejects.toBeInstanceOf(BdError);
  });

  it('uses custom bdPath when provided', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliDependencyWriter(runner, {
      bdPath: '/usr/bin/bd',
    });

    await port.addDependency(ROOT, ISSUE_ID, DEPENDS_ON_ID);

    expect(calls[0]?.command).toBe('/usr/bin/bd');
  });
});
