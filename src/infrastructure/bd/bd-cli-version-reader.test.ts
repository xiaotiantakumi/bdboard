import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { EXPECTED_BD_VERSION } from '../../domain/bd-version-check.js';
import { readBdVersion } from './bd-cli-version-reader.js';

const ROOT = '/root/proj';

function createFakeRunner(result: CommandResult): {
  readonly runner: CommandRunner;
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options: { cwd?: string; timeoutMs?: number } | undefined;
  }>;
} {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options: { cwd?: string; timeoutMs?: number } | undefined;
  }> = [];

  return {
    runner: {
      async run(command, args, options) {
        calls.push({ command, args, options });
        return result;
      },
    },
    calls,
  };
}

describe('readBdVersion', () => {
  it('runs bd version --json through CommandRunner and returns its version', async () => {
    const { runner, calls } = createFakeRunner({
      stdout: JSON.stringify({ version: EXPECTED_BD_VERSION, schema_version: 1, build: 'Homebrew' }),
      stderr: '',
      exitCode: 0,
    });

    await expect(readBdVersion(runner, 'custom-bd', 3_000, ROOT)).resolves.toBe(EXPECTED_BD_VERSION);
    expect(calls).toEqual([
      {
        command: 'custom-bd',
        args: ['version', '--json'],
        options: { cwd: ROOT, timeoutMs: 3_000 },
      },
    ]);
  });

  it('returns null when bd cannot be run', async () => {
    const { runner } = createFakeRunner({ stdout: '', stderr: 'not found', exitCode: 127 });

    await expect(readBdVersion(runner, 'bd', 3_000, ROOT)).resolves.toBeNull();
  });

  it('returns null when bd returns invalid JSON or an unexpected schema', async () => {
    const invalidJson = createFakeRunner({ stdout: 'not json', stderr: '', exitCode: 0 });
    const invalidSchema = createFakeRunner({
      stdout: JSON.stringify({ version: 123, schema_version: 1 }),
      stderr: '',
      exitCode: 0,
    });

    await expect(readBdVersion(invalidJson.runner, 'bd', 3_000, ROOT)).resolves.toBeNull();
    await expect(readBdVersion(invalidSchema.runner, 'bd', 3_000, ROOT)).resolves.toBeNull();
  });

  it('still returns the version when schema_version is missing (upstream may drop/change it)', async () => {
    const { runner } = createFakeRunner({
      stdout: JSON.stringify({ version: EXPECTED_BD_VERSION }),
      stderr: '',
      exitCode: 0,
    });

    await expect(readBdVersion(runner, 'bd', 3_000, ROOT)).resolves.toBe(EXPECTED_BD_VERSION);
  });
});
