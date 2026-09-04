import { describe, expect, it } from 'vitest';
import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  buildGateCloseReason,
  buildResponseCommentBody,
  buildTicketResponseCommentBody,
  buildUnknownKindResponseCommentBody,
  createBdCliHumanDecisions,
  parseShowStdoutForKind,
  resolveKind,
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

const expectedGateListArgs = (rootPath: string): readonly string[] => [
  '--readonly',
  '-C',
  rootPath,
  'gate',
  'list',
  '--json',
  '--limit',
  '0',
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

const expectedUnknownResponseCommentArgs = (
  rootPath: string,
  issueId: string,
  responseText: string,
): readonly string[] => [
  '-C',
  rootPath,
  'comment',
  issueId,
  buildResponseCommentBody(responseText, 'unknown'),
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
    options?: CommandRunOptions,
  ) => Promise<CommandResult> | CommandResult;
}

function createFakeRunner(options: FakeRunnerOptions = {}): {
  runner: CommandRunner;
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: CommandRunOptions;
  }>;
} {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options?: CommandRunOptions;
  }> = [];

  const runner: CommandRunner = {
    async run(command, args, runOptions) {
      calls.push({ command, args, options: runOptions });
      if (options.handler) {
        return await options.handler(command, args, runOptions);
      }
      return { stdout: '[]', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

function isHumanListCall(args: readonly string[]): boolean {
  return args.includes('list') && args.includes('-l') && args.includes('human');
}

function isGateListCall(args: readonly string[]): boolean {
  return args.includes('gate') && args.includes('list');
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
      handler: async (_command, args) => {
        if (isHumanListCall(args)) {
          return {
            stdout: JSON.stringify([{ title: 'missing id' }, { id: 'bdboard-ok' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
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
      handler: async (_command, args) => {
        if (isHumanListCall(args)) {
          return { stdout: '', stderr: 'database is locked', exitCode: 1 };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    });

    const port = createBdCliHumanDecisions(runner);
    await expect(port.listPendingDecisions('/root/proj')).rejects.toMatchObject({
      kind: 'lock-contention',
    } satisfies Partial<BdError>);
  });

  it('throws BdError when bd gate list exits with failure (no fail-soft)', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (isGateListCall(args)) {
          return { stdout: '', stderr: 'database is locked', exitCode: 1 };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    });

    const port = createBdCliHumanDecisions(runner);
    await expect(port.listPendingDecisions('/root/proj')).rejects.toMatchObject({
      kind: 'lock-contention',
    } satisfies Partial<BdError>);
  });

  it('retries once on lock-contention and succeeds on the second attempt (bdboard-3tj)', async () => {
    let listAttempts = 0;
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (isHumanListCall(args)) {
          listAttempts += 1;
          if (listAttempts === 1) {
            return { stdout: '', stderr: 'database is locked', exitCode: 1 };
          }
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it('calls bd list -l human and bd gate list with expected args', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    await port.listPendingDecisions('/my/root');

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      command: '/usr/bin/bd',
      args: expectedListArgs('/my/root'),
      options: { timeoutMs: 30_000 },
    });
    expect(calls[1]).toEqual({
      command: '/usr/bin/bd',
      args: expectedGateListArgs('/my/root'),
      options: { timeoutMs: 30_000 },
    });
    expect(calls[0]?.args).toContain('--readonly');
    expect(calls[1]?.args).not.toContain('--no-pager');
  });

  it('includes human gates from bd gate list as kind gate', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (isHumanListCall(args)) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        if (isGateListCall(args)) {
          return {
            stdout: JSON.stringify([
              {
                id: 'bdboard-0as',
                issue_type: 'gate',
                await_type: 'human',
                description: 'Ad-hoc gate',
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      { id: 'bdboard-0as', kind: 'gate', allowFreeform: true },
    ]);
  });

  it('excludes non-human gates from bd gate list', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (isGateListCall(args)) {
          return {
            stdout: JSON.stringify([
              { id: 'bdboard-timer', issue_type: 'gate', await_type: 'timer' },
              { id: 'bdboard-human', issue_type: 'gate', await_type: 'human' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      { id: 'bdboard-human', kind: 'gate', allowFreeform: true },
    ]);
  });

  it('excludes gate list rows that are not issue_type gate', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (isGateListCall(args)) {
          return {
            stdout: JSON.stringify([
              { id: 'bdboard-task', issue_type: 'task', await_type: 'human' },
              { id: 'bdboard-gate', issue_type: 'gate', await_type: 'human' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      { id: 'bdboard-gate', kind: 'gate', allowFreeform: true },
    ]);
  });

  it('overwrites kind to gate while preserving label metadata when the same id appears in both lists', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (isHumanListCall(args)) {
          return {
            stdout: JSON.stringify([
              {
                id: 'bdboard-shared',
                issue_type: 'task',
                metadata: {
                  decision_question: 'Which path?',
                  decision_options: '[{"label":"A","value":"a"}]',
                  decision_allow_freeform: false,
                },
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (isGateListCall(args)) {
          return {
            stdout: JSON.stringify([
              {
                id: 'bdboard-shared',
                issue_type: 'gate',
                await_type: 'human',
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      {
        id: 'bdboard-shared',
        kind: 'gate',
        question: 'Which path?',
        options: [{ label: 'A', value: 'a' }],
        allowFreeform: false,
      },
    ]);
  });

  it('skips malformed gate list rows without hiding valid rows', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (isGateListCall(args)) {
          return {
            stdout: JSON.stringify([
              { title: 'missing id' },
              { id: 'bdboard-ok', issue_type: 'gate', await_type: 'human' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    });

    const port = createBdCliHumanDecisions(runner);
    const decisions = await port.listPendingDecisions('/root/proj');

    expect(decisions).toEqual([
      { id: 'bdboard-ok', kind: 'gate', allowFreeform: true },
    ]);
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
        options: { timeoutMs: 5_000 },
      },
      {
        command: '/usr/bin/bd',
        args: expectedGateResponseCommentArgs('/my/root', issueId, 'A案を採用'),
        options: { timeoutMs: 30_000 },
      },
      {
        command: '/usr/bin/bd',
        args: expectedCloseRespondedIssueArgs('/my/root', issueId, 'A案を採用'),
        options: { timeoutMs: 30_000 },
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
        options: { timeoutMs: 5_000 },
      },
      {
        command: '/usr/bin/bd',
        args: expectedTicketResponseCommentArgs('/my/root', issueId, 'A案を採用'),
        options: { timeoutMs: 30_000 },
      },
      {
        command: '/usr/bin/bd',
        args: expectedRemoveHumanLabelArgs('/my/root', issueId),
        options: { timeoutMs: 30_000 },
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

  it('records a comment but does not close or remove label when kind is unknown', async () => {
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

    expect(outcome).toEqual({ kind: 'unknown', closed: false });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(
      expectedUnknownResponseCommentArgs('/my/root', issueId, 'fallback answer'),
    );
    expect(calls.some((call) => call.args.includes('close'))).toBe(false);
    expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
    expect(buildUnknownKindResponseCommentBody('fallback answer')).toContain(
      '確認待ちのまま残ります',
    );
  });

  it('records a comment but does not close or remove label when show stdout is invalid JSON', async () => {
    const issueId = 'bdboard-bad-json';
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return { stdout: '{not json', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliHumanDecisions(runner);

    const outcome = await port.respond('/my/root', issueId, 'still recorded');

    expect(outcome).toEqual({ kind: 'unknown', closed: false });
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.args.includes('close'))).toBe(false);
    expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
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

  it('strips control characters such as ESC and BS from close reasons', () => {
    const answer = `before${String.fromCharCode(0x1b)}after${String.fromCharCode(0x08)}end`;
    const reason = buildGateCloseReason(answer);

    expect(reason).not.toContain(String.fromCharCode(0x1b));
    expect(reason).not.toContain(String.fromCharCode(0x08));
    expect(reason).toContain('before after end');
  });

  it('truncates by code point so surrogate pairs are not split', () => {
    const emoji = '😀';
    const answer = `${'x'.repeat(199)}${emoji}`;
    const reason = buildGateCloseReason(answer);
    const truncatedPart = reason.replace(/^Responded: /, '').replace(/…$/, '');

    expect(Array.from(truncatedPart).length).toBeLessThanOrEqual(200);
    expect(/[\uD800-\uDBFF]$/.test(truncatedPart)).toBe(false);
  });
});

// bdboard-xgvh: gate と判定できたときだけ close する、という fail-safe の中核。
// respond() 経由の結合テストは「show が exit != 0」の経路しか押さえていなかったので、
// 壊れた stdout の分岐をここで直接押さえる。どれか1つでも 'gate' に倒れると、
// 実作業チケットを誤クローズする元のバグが復活する。
describe('parseShowStdoutForKind', () => {
  it('returns gate only for an exact issue_type match', () => {
    expect(parseShowStdoutForKind('[{"issue_type":"gate"}]')).toBe('gate');
  });

  it('returns ticket when issue_type is missing after successful parse', () => {
    expect(parseShowStdoutForKind('[{"id":"bdboard-1"}]')).toBe('ticket');
  });

  it.each([
    ['empty stdout', ''],
    ['whitespace only', '   \n\t '],
    ['invalid JSON', '{not json'],
    ['a bare object instead of an array', '{"issue_type":"gate"}'],
    ['an empty array', '[]'],
    ['a null first element', '[null]'],
    ['a non-object first element', '["gate"]'],
    ['a null issue_type', '[{"issue_type":null}]'],
    ['a non-string issue_type', '[{"issue_type":42}]'],
  ])('returns unknown for %s', (_label, stdout) => {
    expect(parseShowStdoutForKind(stdout)).toBe('unknown');
  });

  it.each([
    ['a different issue_type', '[{"issue_type":"task"}]'],
    ['a case-mismatched issue_type', '[{"issue_type":"Gate"}]'],
  ])('returns ticket for %s', (_label, stdout) => {
    expect(parseShowStdoutForKind(stdout)).toBe('ticket');
  });
});

describe('resolveKind', () => {
  it('uses a 5s timeout and does not retry on lock-contention', async () => {
    let showAttempts = 0;
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          showAttempts += 1;
          return { stdout: '', stderr: 'database is locked', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const kind = await resolveKind(runner, 'bd', '/my/root', 'bdboard-probe');

    expect(kind).toBe('unknown');
    expect(showAttempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ timeoutMs: 5_000 });
  });
});
