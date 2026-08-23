import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { createBdCliLeaseReader } from './bd-cli-lease-reader.js';

const ROOT = '/root/proj';

const expectedListArgs = (rootPath: string): readonly string[] => [
  '--readonly',
  '-C',
  rootPath,
  'list',
  '--status',
  'in_progress',
  '--json',
  '--limit',
  '0',
  '--no-pager',
];

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
      return { stdout: '[]', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

describe('createBdCliLeaseReader', () => {
  it('passes the expected command and args including --readonly', async () => {
    const { runner, calls } = createFakeRunner();
    const reader = createBdCliLeaseReader(runner, { bdPath: '/usr/bin/bd' });

    await reader.listInProgressWithLease(ROOT);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: '/usr/bin/bd',
      args: expectedListArgs(ROOT),
    });
  });

  it('maps bd list JSON into InProgressWithLease entries', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          { id: 'bdboard-1', lease_expires_at: '2026-08-23T00:00:00Z', heartbeat_at: '2026-08-22T23:59:00Z' },
          { id: 'bdboard-2' },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createBdCliLeaseReader(runner);
    const result = await reader.listInProgressWithLease(ROOT);

    expect(result).toEqual([
      {
        id: 'bdboard-1',
        leaseExpiresAt: '2026-08-23T00:00:00Z',
        heartbeatAt: '2026-08-22T23:59:00Z',
      },
      { id: 'bdboard-2', leaseExpiresAt: null, heartbeatAt: null },
    ]);
  });

  it('treats empty stdout as an empty list', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });

    const reader = createBdCliLeaseReader(runner);
    const result = await reader.listInProgressWithLease(ROOT);

    expect(result).toEqual([]);
  });

  it('classifies lock-contention errors', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr: 'database is locked', exitCode: 1 }),
    });

    const reader = createBdCliLeaseReader(runner);
    await expect(reader.listInProgressWithLease(ROOT)).rejects.toMatchObject({
      kind: 'lock-contention',
    } satisfies Partial<BdError>);
  });

  it('classifies not-a-beads-project errors', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr: 'not a beads project', exitCode: 1 }),
    });

    const reader = createBdCliLeaseReader(runner);
    await expect(reader.listInProgressWithLease(ROOT)).rejects.toMatchObject({
      kind: 'not-a-beads-project',
    } satisfies Partial<BdError>);
  });

  it('throws schema-mismatch for invalid JSON', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: 'not-json', stderr: '', exitCode: 0 }),
    });

    const reader = createBdCliLeaseReader(runner);
    await expect(reader.listInProgressWithLease(ROOT)).rejects.toMatchObject({
      kind: 'schema-mismatch',
    } satisfies Partial<BdError>);
  });

  it('retries once on lock-contention and succeeds on the second attempt (bdboard-3tj)', async () => {
    let attempts = 0;
    const { runner, calls } = createFakeRunner({
      handler: async () => {
        attempts += 1;
        if (attempts === 1) {
          return { stdout: '', stderr: 'database is locked', exitCode: 1 };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    });

    const reader = createBdCliLeaseReader(runner);
    const result = await reader.listInProgressWithLease(ROOT);

    expect(result).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});
