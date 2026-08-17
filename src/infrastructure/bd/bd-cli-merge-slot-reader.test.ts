import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { createBdCliMergeSlotReader } from './bd-cli-merge-slot-reader.js';

const ROOT = '/root/proj';

interface FakeRunnerOptions {
  readonly handler?: (
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ) => Promise<CommandResult> | CommandResult;
}

function createFakeRunner(options: FakeRunnerOptions = {}): {
  runner: CommandRunner;
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: { timeoutMs?: number };
  }>;
} {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options?: { timeoutMs?: number };
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

describe('createBdCliMergeSlotReader', () => {
  it('invokes bd list with gt:slot label and readonly flags', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async () => ({ stdout: '[]', stderr: '', exitCode: 0 }),
    });
    const reader = createBdCliMergeSlotReader(runner);

    await reader.readMergeSlotSignal(ROOT);

    expect(calls).toEqual([
      {
        command: 'bd',
        args: [
          '--readonly',
          '-C',
          ROOT,
          'list',
          '--label',
          'gt:slot',
          '--json',
          '--limit',
          '0',
          '--no-pager',
        ],
        options: { timeoutMs: 30_000 },
      },
    ]);
  });

  it('maps held merge slot status from bd JSON', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          {
            id: 'bdboard-merge-slot',
            status: 'in_progress',
            updated_at: '2026-08-17T10:47:14Z',
            metadata: { holder: 'session-31fdf8f9-bdboard-3tw.107' },
          },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });
    const reader = createBdCliMergeSlotReader(runner);

    const signal = await reader.readMergeSlotSignal(ROOT);

    expect(signal).toEqual({
      status: 'in_progress',
      holder: 'session-31fdf8f9-bdboard-3tw.107',
      updatedAt: '2026-08-17T10:47:14Z',
    });
  });

  it('maps open merge slot status with null holder when metadata is absent', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          {
            id: 'bdboard-merge-slot',
            status: 'open',
            updated_at: '2026-08-17T10:48:26Z',
          },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });
    const reader = createBdCliMergeSlotReader(runner);

    const signal = await reader.readMergeSlotSignal(ROOT);

    expect(signal).toEqual({
      status: 'open',
      holder: null,
      updatedAt: '2026-08-17T10:48:26Z',
    });
  });

  it('returns null for empty stdout', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    const reader = createBdCliMergeSlotReader(runner);

    await expect(reader.readMergeSlotSignal(ROOT)).resolves.toBeNull();
  });

  it('returns null for empty JSON array', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '[]', stderr: '', exitCode: 0 }),
    });
    const reader = createBdCliMergeSlotReader(runner);

    await expect(reader.readMergeSlotSignal(ROOT)).resolves.toBeNull();
  });

  it('throws BdError when bd exits non-zero', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'not a beads project',
        exitCode: 1,
      }),
    });
    const reader = createBdCliMergeSlotReader(runner);

    await expect(reader.readMergeSlotSignal(ROOT)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(BdError);
      expect((error as BdError).kind).toBe('not-a-beads-project');
      return true;
    });
  });

  it('throws schema-mismatch BdError for invalid JSON', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: 'not-json', stderr: '', exitCode: 0 }),
    });
    const reader = createBdCliMergeSlotReader(runner);

    await expect(reader.readMergeSlotSignal(ROOT)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(BdError);
      expect((error as BdError).kind).toBe('schema-mismatch');
      return true;
    });
  });
});
