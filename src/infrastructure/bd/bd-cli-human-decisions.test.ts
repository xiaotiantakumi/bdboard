import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { createBdCliHumanDecisions } from './bd-cli-human-decisions.js';

const expectedListArgs = (rootPath: string): readonly string[] => [
  '--readonly',
  '-C',
  rootPath,
  'list',
  '-l',
  'human',
  '--json',
  '--limit',
  '0',
  '--no-pager',
];

const expectedAddResponseCommentArgs = (
  rootPath: string,
  issueId: string,
  responseText: string,
): readonly string[] => [
  '-C',
  rootPath,
  'comment',
  issueId,
  `Response: ${responseText}`,
];

const expectedCloseRespondedIssueArgs = (
  rootPath: string,
  issueId: string,
): readonly string[] => ['-C', rootPath, 'close', issueId, '--reason', 'Responded'];

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

describe('createBdCliHumanDecisions', () => {
  it('parses metadata with options JSON string and question', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          {
            id: 'bdboard-kxi',
            metadata: {
              decision_question: 'どのアプローチを採用しますか?',
              decision_options:
                '[{"label":"A案","value":"a"},{"label":"B案","value":"b"}]',
              decision_allow_freeform: true,
            },
          },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      {
        id: 'bdboard-kxi',
        question: 'どのアプローチを採用しますか?',
        options: [
          { label: 'A案', value: 'a' },
          { label: 'B案', value: 'b' },
        ],
        allowFreeform: true,
      },
    ]);
  });

  it('falls back to no options when decision_options JSON is invalid', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          {
            id: 'bdboard-bad',
            metadata: {
              decision_options: 'not-json',
            },
          },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      {
        id: 'bdboard-bad',
        allowFreeform: true,
      },
    ]);
  });

  it('parses decision_allow_freeform from string values', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          {
            id: 'bdboard-false',
            metadata: {
              decision_allow_freeform: 'false',
            },
          },
          {
            id: 'bdboard-true',
            metadata: {
              decision_allow_freeform: 'true',
            },
          },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      { id: 'bdboard-false', allowFreeform: false },
      { id: 'bdboard-true', allowFreeform: true },
    ]);
  });

  it('omits question when decision_question is missing', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          {
            id: 'bdboard-plain',
            metadata: {},
          },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      {
        id: 'bdboard-plain',
        allowFreeform: true,
      },
    ]);
  });

  it('skips items that fail schema validation without failing the whole list', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          { title: 'missing id' },
          { id: 'bdboard-ok' },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      {
        id: 'bdboard-ok',
        allowFreeform: true,
      },
    ]);
  });

  it('throws BdError when bd list exits with failure', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'database is locked',
        exitCode: 1,
      }),
    });

    const port = createBdCliHumanDecisions(runner);
    await expect(port.listPendingDecisions('/root/proj')).rejects.toMatchObject({
      kind: 'lock-contention',
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

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('passes the expected list command args including --readonly', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    await port.listPendingDecisions('/my/root');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: '/usr/bin/bd',
      args: expectedListArgs('/my/root'),
    });
    expect(calls[0]?.args).toContain('--readonly');
  });

  it('adds a response comment and then closes the issue without --readonly', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    await port.respond('/my/root', 'bdboard-abc', 'A案を採用');

    expect(calls).toEqual([
      {
        command: '/usr/bin/bd',
        args: expectedAddResponseCommentArgs('/my/root', 'bdboard-abc', 'A案を採用'),
      },
      {
        command: '/usr/bin/bd',
        args: expectedCloseRespondedIssueArgs('/my/root', 'bdboard-abc'),
      },
    ]);
    expect(calls.flatMap((call) => call.args)).not.toContain('--readonly');
  });

  it('does not close the issue when adding the response comment fails', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'database is locked',
        exitCode: 1,
      }),
    });
    const port = createBdCliHumanDecisions(runner);

    await expect(port.respond('/my/root', 'bdboard-abc', 'A案を採用')).rejects.toMatchObject({
      kind: 'lock-contention',
    } satisfies Partial<BdError>);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(
      expectedAddResponseCommentArgs('/my/root', 'bdboard-abc', 'A案を採用'),
    );
  });

  it('propagates a close failure after adding the response comment', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('close')) {
          return { stdout: '', stderr: 'bd command not found', exitCode: 127 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliHumanDecisions(runner);

    await expect(port.respond('/my/root', 'bdboard-abc', 'A案を採用')).rejects.toMatchObject({
      kind: 'bd-not-found',
    } satisfies Partial<BdError>);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(
      expectedCloseRespondedIssueArgs('/my/root', 'bdboard-abc'),
    );
  });
});
