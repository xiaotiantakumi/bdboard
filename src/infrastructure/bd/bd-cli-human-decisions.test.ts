import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  buildGateCloseReason,
  buildResponseCommentBody,
  buildTicketResponseCommentBody,
  createBdCliHumanDecisions,
} from './bd-cli-human-decisions.js';

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

const expectedShowArgs = (rootPath: string, issueId: string): readonly string[] => [
  '--readonly',
  '-C',
  rootPath,
  'show',
  issueId,
  '--json',
];

const expectedGateResponseCommentArgs = (
  rootPath: string,
  issueId: string,
  responseText: string,
): readonly string[] => [
  '-C',
  rootPath,
  'comment',
  issueId,
  buildResponseCommentBody(responseText, 'gate'),
];

const expectedTicketResponseCommentArgs = (
  rootPath: string,
  issueId: string,
  responseText: string,
): readonly string[] => [
  '-C',
  rootPath,
  'comment',
  issueId,
  buildResponseCommentBody(responseText, 'ticket'),
];

const expectedCloseRespondedIssueArgs = (
  rootPath: string,
  issueId: string,
  responseText: string,
): readonly string[] => [
  '-C',
  rootPath,
  'close',
  issueId,
  '--reason',
  buildGateCloseReason(responseText),
];

const expectedRemoveHumanLabelArgs = (
  rootPath: string,
  issueId: string,
): readonly string[] => ['-C', rootPath, 'label', 'remove', issueId, 'human'];

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

function showGateHandler(issueId: string) {
  return async (_command: string, args: readonly string[]) => {
    if (args.includes('show')) {
      return {
        stdout: JSON.stringify([{ id: issueId, issue_type: 'gate' }]),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

function showTaskHandler(issueId: string) {
  return async (_command: string, args: readonly string[]) => {
    if (args.includes('show')) {
      return {
        stdout: JSON.stringify([{ id: issueId, issue_type: 'task' }]),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
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
        kind: 'ticket',
        question: 'どのアプローチを採用しますか?',
        options: [
          { label: 'A案', value: 'a' },
          { label: 'B案', value: 'b' },
        ],
        allowFreeform: true,
      },
    ]);
  });

  it('maps issue_type gate to kind gate and other values to ticket', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          { id: 'bdboard-gate', issue_type: 'gate' },
          { id: 'bdboard-task', issue_type: 'task' },
          { id: 'bdboard-missing' },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      { id: 'bdboard-gate', kind: 'gate', allowFreeform: true },
      { id: 'bdboard-task', kind: 'ticket', allowFreeform: true },
      { id: 'bdboard-missing', kind: 'ticket', allowFreeform: true },
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
        kind: 'ticket',
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
      { id: 'bdboard-false', kind: 'ticket', allowFreeform: false },
      { id: 'bdboard-true', kind: 'ticket', allowFreeform: true },
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
        kind: 'ticket',
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
        kind: 'ticket',
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

  it('closes a gate after adding a response comment with a reason derived from the answer', async () => {
    const issueId = 'bdboard-gate';
    const { runner, calls } = createFakeRunner({
      handler: showGateHandler(issueId),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({ kind: 'gate', closed: true });
    expect(calls).toEqual([
      {
        command: '/usr/bin/bd',
        args: expectedShowArgs('/my/root', issueId),
      },
      {
        command: '/usr/bin/bd',
        args: expectedGateResponseCommentArgs('/my/root', issueId, 'A案を採用'),
      },
      {
        command: '/usr/bin/bd',
        args: expectedCloseRespondedIssueArgs('/my/root', issueId, 'A案を採用'),
      },
    ]);
    // respond の書き込み呼び出し(comment / close)は --readonly を付けない。
    // 先頭の show 呼び出しだけは読み取り専用なので --readonly を付ける。
    expect(calls[0]?.args).toContain('--readonly');
    expect(calls[1]?.args).not.toContain('--readonly');
    expect(calls[2]?.args).not.toContain('--readonly');
    expect(calls[2]?.args[5]).toMatch(/^Responded: /);
    expect(calls[2]?.args[5]).toContain('A案を採用');
  });

  it('removes the human label for a work ticket without closing it', async () => {
    const issueId = 'bdboard-task';
    const { runner, calls } = createFakeRunner({
      handler: showTaskHandler(issueId),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({ kind: 'ticket', closed: false });
    expect(calls).toEqual([
      {
        command: '/usr/bin/bd',
        args: expectedShowArgs('/my/root', issueId),
      },
      {
        command: '/usr/bin/bd',
        args: expectedTicketResponseCommentArgs('/my/root', issueId, 'A案を採用'),
      },
      {
        command: '/usr/bin/bd',
        args: expectedRemoveHumanLabelArgs('/my/root', issueId),
      },
    ]);
    expect(calls.some((call) => call.args.includes('close'))).toBe(false);
    expect(buildTicketResponseCommentBody('A案を採用')).toContain('close せず');
    // respond の書き込み呼び出し(comment / label remove)は --readonly を付けない。
    // 先頭の show 呼び出しだけは読み取り専用なので --readonly を付ける。
    expect(calls[0]?.args).toContain('--readonly');
    expect(calls[1]?.args).not.toContain('--readonly');
    expect(calls[2]?.args).not.toContain('--readonly');
  });

  it('uses the ticket path when show fails and does not close the issue', async () => {
    const issueId = 'bdboard-fallback';
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return { stdout: '', stderr: 'not found', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliHumanDecisions(runner);

    const outcome = await port.respond('/my/root', issueId, 'fallback answer');

    expect(outcome).toEqual({ kind: 'ticket', closed: false });
    expect(calls.some((call) => call.args.includes('close'))).toBe(false);
    expect(calls.some((call) => call.args.includes('remove'))).toBe(true);
  });

  it('does not close the issue when adding the response comment fails', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: 'bdboard-abc', issue_type: 'gate' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return {
          stdout: '',
          stderr: 'database is locked',
          exitCode: 1,
        };
      },
    });
    const port = createBdCliHumanDecisions(runner);

    await expect(port.respond('/my/root', 'bdboard-abc', 'A案を採用')).rejects.toMatchObject({
      kind: 'lock-contention',
    } satisfies Partial<BdError>);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(
      expectedGateResponseCommentArgs('/my/root', 'bdboard-abc', 'A案を採用'),
    );
  });

  it('propagates a close failure after adding the response comment on a gate', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: 'bdboard-abc', issue_type: 'gate' }]),
            stderr: '',
            exitCode: 0,
          };
        }
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
    expect(calls).toHaveLength(3);
    expect(calls[2]?.args).toEqual(
      expectedCloseRespondedIssueArgs('/my/root', 'bdboard-abc', 'A案を採用'),
    );
  });

  it('propagates a label-remove failure after adding the response comment on a ticket', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: 'bdboard-abc', issue_type: 'task' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('remove')) {
          return { stdout: '', stderr: 'bd command not found', exitCode: 127 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliHumanDecisions(runner);

    await expect(port.respond('/my/root', 'bdboard-abc', 'A案を採用')).rejects.toMatchObject({
      kind: 'bd-not-found',
    } satisfies Partial<BdError>);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.args).toEqual(
      expectedRemoveHumanLabelArgs('/my/root', 'bdboard-abc'),
    );
  });
});

describe('buildGateCloseReason', () => {
  it('collapses multiline whitespace and truncates long answers with an ellipsis', () => {
    const longAnswer = 'line one\n\nline two   line three '.repeat(20);
    const reason = buildGateCloseReason(longAnswer);

    expect(reason.startsWith('Responded: ')).toBe(true);
    expect(reason.endsWith('…')).toBe(true);
    expect(reason.length).toBeLessThanOrEqual('Responded: '.length + 200 + 1);
    expect(reason).toContain('line one line two line three');
  });

  it('falls back to Responded when the answer is only whitespace', () => {
    expect(buildGateCloseReason('   \n\t  ')).toBe('Responded');
  });
});
