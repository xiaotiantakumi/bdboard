import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { createBdCliSessionLinkWriter } from './bd-cli-session-link-writer.js';

const ROOT = '/root/proj';
const TICKET_ID = 'bdboard-3tw.67';
const SESSION_ID = 'example-session-uuid';

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

describe('createBdCliSessionLinkWriter', () => {
  it('links a session via bd update --set-metadata', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliSessionLinkWriter(runner);

    await port.linkSession(ROOT, TICKET_ID, SESSION_ID);

    expect(calls).toEqual([
      {
        command: 'bd',
        args: [
          '-C',
          ROOT,
          'update',
          TICKET_ID,
          '--set-metadata',
          `bdboard.session=${SESSION_ID}`,
        ],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
    ]);
  });

  it('unlinks a session via bd update --unset-metadata', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliSessionLinkWriter(runner);

    await port.unlinkSession(ROOT, TICKET_ID);

    expect(calls).toEqual([
      {
        command: 'bd',
        args: [
          '-C',
          ROOT,
          'update',
          TICKET_ID,
          '--unset-metadata',
          'bdboard.session',
        ],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
    ]);
  });

  it('throws BdError with bd stderr detail when link fails', async () => {
    const stderr = 'error: database is locked';
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr, exitCode: 1 }),
    });
    const port = createBdCliSessionLinkWriter(runner);

    await expect(
      port.linkSession(ROOT, TICKET_ID, SESSION_ID),
    ).rejects.toMatchObject({ detail: stderr.toLowerCase() });
  });

  it('throws BdError with bd stderr detail when unlink fails', async () => {
    const stderr = 'no issue found matching the provided IDs';
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr, exitCode: 1 }),
    });
    const port = createBdCliSessionLinkWriter(runner);

    await expect(port.unlinkSession(ROOT, TICKET_ID)).rejects.toMatchObject({
      detail: stderr.toLowerCase(),
    });
  });

  it('rejects an invalid ticket id without invoking the runner', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliSessionLinkWriter(runner);

    await expect(
      port.linkSession(ROOT, '-rf', SESSION_ID),
    ).rejects.toBeInstanceOf(BdError);
    expect(calls).toHaveLength(0);
  });

  it('rejects an unsafe session id without invoking the runner', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliSessionLinkWriter(runner);

    await expect(
      port.linkSession(ROOT, TICKET_ID, '-rf'),
    ).rejects.toBeInstanceOf(BdError);
    expect(calls).toHaveLength(0);
  });

  it('uses custom bdPath when provided', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliSessionLinkWriter(runner, {
      bdPath: '/usr/bin/bd',
    });

    await port.linkSession(ROOT, TICKET_ID, SESSION_ID);

    expect(calls[0]?.command).toBe('/usr/bin/bd');
  });
});
