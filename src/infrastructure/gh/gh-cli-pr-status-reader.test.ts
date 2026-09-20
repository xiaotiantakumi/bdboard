import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { createGhCliPrStatusReader } from './gh-cli-pr-status-reader.js';

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

const PR_URL = 'https://github.com/xiaotiantakumi/bdboard/pull/1';

describe('createGhCliPrStatusReader', () => {
  it('maps OPEN state with all passing checks', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({
          state: 'OPEN',
          statusCheckRollup: [
            {
              __typename: 'CheckRun',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
            },
            {
              __typename: 'StatusContext',
              state: 'SUCCESS',
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    const result = await reader.getPrStatus(PR_URL);

    expect(result).toEqual({ status: { state: 'open', checkStatus: 'pass' } });
  });

  it('maps MERGED state', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({
          state: 'MERGED',
          statusCheckRollup: [
            {
              __typename: 'CheckRun',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    const result = await reader.getPrStatus(PR_URL);

    expect(result).toEqual({ status: { state: 'merged', checkStatus: 'pass' } });
  });

  it('returns fail when any rollup item indicates failure', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({
          state: 'OPEN',
          statusCheckRollup: [
            {
              __typename: 'CheckRun',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
            },
            {
              __typename: 'CheckRun',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    const result = await reader.getPrStatus(PR_URL);

    expect(result).toEqual({ status: { state: 'open', checkStatus: 'fail' } });
  });

  it('returns pending when checks are incomplete without failures', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({
          state: 'OPEN',
          statusCheckRollup: [
            {
              __typename: 'CheckRun',
              status: 'IN_PROGRESS',
              conclusion: null,
            },
            {
              __typename: 'StatusContext',
              state: 'PENDING',
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    const result = await reader.getPrStatus(PR_URL);

    expect(result).toEqual({ status: { state: 'open', checkStatus: 'pending' } });
  });

  it('returns unknown check status for empty or missing rollup', async () => {
    const { runner: emptyRunner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({ state: 'OPEN', statusCheckRollup: [] }),
        stderr: '',
        exitCode: 0,
      }),
    });
    const { runner: nullRunner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({ state: 'OPEN', statusCheckRollup: null }),
        stderr: '',
        exitCode: 0,
      }),
    });

    const emptyReader = createGhCliPrStatusReader(emptyRunner);
    const nullReader = createGhCliPrStatusReader(nullRunner);

    expect(await emptyReader.getPrStatus(PR_URL)).toEqual({
      status: { state: 'open', checkStatus: 'unknown' },
    });
    expect(await nullReader.getPrStatus(PR_URL)).toEqual({
      status: { state: 'open', checkStatus: 'unknown' },
    });
  });

  it('returns a not-found failure for an unresolvable PR without throwing', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 999999.',
        exitCode: 1,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    await expect(reader.getPrStatus(PR_URL)).resolves.toEqual({
      status: null,
      reason: 'not-found',
    });
  });

  it('returns an other failure for a generic non-zero exit without throwing', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'unexpected failure',
        exitCode: 1,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    await expect(reader.getPrStatus(PR_URL)).resolves.toEqual({
      status: null,
      reason: 'other',
    });
  });

  it('classifies "API rate limit" stderr as a rate-limit failure', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr:
          "gh: API rate limit exceeded for user ID 12345678. (HTTP 403)",
        exitCode: 1,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    await expect(reader.getPrStatus(PR_URL)).resolves.toEqual({
      status: null,
      reason: 'rate-limit',
    });
  });

  it('classifies "secondary rate limit" stderr as a rate-limit failure', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'You have exceeded a secondary rate limit. Please wait a few minutes.',
        exitCode: 1,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    await expect(reader.getPrStatus(PR_URL)).resolves.toEqual({
      status: null,
      reason: 'rate-limit',
    });
  });

  it('classifies a bare HTTP 429 as a rate-limit failure', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'gh: Too many requests. (HTTP 429)',
        exitCode: 1,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    await expect(reader.getPrStatus(PR_URL)).resolves.toEqual({
      status: null,
      reason: 'rate-limit',
    });
  });

  it('classifies a timeout failureKind as a timeout failure', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: '',
        exitCode: 124,
        failureKind: 'timeout',
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    await expect(reader.getPrStatus(PR_URL)).resolves.toEqual({
      status: null,
      reason: 'timeout',
    });
  });

  it('returns an other failure for invalid JSON without throwing', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: 'not-json',
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    await expect(reader.getPrStatus(PR_URL)).resolves.toEqual({
      status: null,
      reason: 'other',
    });
  });

  it('returns an other failure for schema mismatch without throwing', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({ state: 'OPEN', statusCheckRollup: 'not-an-array' }),
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createGhCliPrStatusReader(runner);
    await expect(reader.getPrStatus(PR_URL)).resolves.toEqual({
      status: null,
      reason: 'other',
    });
  });

  it('classifies a thrown rate-limit error from the command runner without throwing', async () => {
    const runner: CommandRunner = {
      run: async () => {
        throw new Error('API rate limit exceeded for user ID 12345678.');
      },
    };

    const reader = createGhCliPrStatusReader(runner);
    await expect(reader.getPrStatus(PR_URL)).resolves.toEqual({
      status: null,
      reason: 'rate-limit',
    });
  });

  it('classifies a generic thrown error from the command runner as other without throwing', async () => {
    const runner: CommandRunner = {
      run: async () => {
        throw new Error('spawn gh ENOENT');
      },
    };

    const reader = createGhCliPrStatusReader(runner);
    await expect(reader.getPrStatus(PR_URL)).resolves.toEqual({
      status: null,
      reason: 'other',
    });
  });

  it('invokes gh pr view with expected arguments', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({
          state: 'OPEN',
          statusCheckRollup: [],
        }),
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createGhCliPrStatusReader(runner, { ghPath: 'gh' });
    await reader.getPrStatus(PR_URL);

    expect(calls).toEqual([
      {
        command: 'gh',
        args: ['pr', 'view', PR_URL, '--json', 'state,statusCheckRollup'],
      },
    ]);
  });
});
