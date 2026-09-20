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
  buildTicketAmbiguousGatesResponseCommentBody,
  buildTicketResponseCommentBody,
  buildUnknownKindResponseCommentBody,
  createBdCliHumanDecisions,
  parseShowStdoutForKind,
  parseShowWithDependentsStdout,
  resolveGateBlockedTicketIds,
  resolveKind,
  resolveKindAndBlockingGates,
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

const expectedShowWithDependentsArgs = (
  rootPath: string,
  issueId: string,
): readonly string[] => [
  '--readonly',
  '-C',
  rootPath,
  'show',
  issueId,
  '--json',
  '--include-dependents',
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

const expectedGateResolveArgs = (
  rootPath: string,
  gateId: string,
  responseText: string,
): readonly string[] => [
  '-C',
  rootPath,
  'gate',
  'resolve',
  gateId,
  '--reason',
  buildGateCloseReason(responseText),
];

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

function showTaskWithDependenciesHandler(
  issueId: string,
  dependencies: readonly Record<string, unknown>[],
) {
  return async (_command: string, args: readonly string[]) => {
    if (args.includes('show')) {
      return {
        stdout: JSON.stringify([{ id: issueId, issue_type: 'task', dependencies }]),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

// bdboard-giyt: gate 側から respond() したときの一連の show 呼び出しを組み立てる。
// - `show <gateId>`(--include-dependents 無し)は kind 判定用(常に issue_type: 'gate')
// - `show <gateId> --include-dependents` は dependents(この gate がブロックしている
//   work ticket)を返す
// - `show <ticketId>`(--include-dependents 無し、gateId 以外の ID)は、その ticket に
//   他に残っている open な human gate を判定するための呼び出し。ticketDependencies に
//   ticketId のエントリが無ければ dependencies: [] を返す(=もう何も残っていない)。
function gateRespondHandler(options: {
  readonly gateId: string;
  readonly dependents?: readonly Record<string, unknown>[];
  readonly ticketDependencies?: Record<string, readonly Record<string, unknown>[]>;
}) {
  return async (_command: string, args: readonly string[]) => {
    if (args.includes('show')) {
      const showIndex = args.indexOf('show');
      const shownId = args[showIndex + 1];
      if (args.includes('--include-dependents')) {
        return {
          stdout: JSON.stringify([
            { id: shownId, issue_type: 'gate', dependents: options.dependents ?? [] },
          ]),
          stderr: '',
          exitCode: 0,
        };
      }
      if (shownId === options.gateId) {
        return {
          stdout: JSON.stringify([{ id: shownId, issue_type: 'gate' }]),
          stderr: '',
          exitCode: 0,
        };
      }
      const dependencies = options.ticketDependencies?.[shownId as string] ?? [];
      return {
        stdout: JSON.stringify([{ id: shownId, issue_type: 'task', dependencies }]),
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

    // showGateHandler returns the same gate-shaped item (no dependents) for every
    // `show` call, including the post-close --include-dependents probe added by
    // bdboard-giyt, so there is nothing to clear and clearedHumanLabelTicketIds is
    // omitted.
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
      {
        command: '/usr/bin/bd',
        args: expectedShowWithDependentsArgs('/my/root', issueId),
        options: { timeoutMs: 5_000 },
      },
    ]);
    // respond の書き込み呼び出し(comment / close)は --readonly を付けない。
    // show 呼び出し(kind 判定・bdboard-giyt の dependents 読み取り)は読み取り専用
    // なので --readonly を付ける。
    expect(calls[0]?.args).toContain('--readonly');
    expect(calls[1]?.args).not.toContain('--readonly');
    expect(calls[2]?.args).not.toContain('--readonly');
    expect(calls[3]?.args).toContain('--readonly');
    expect(calls[2]?.args[5]).toMatch(/^Responded: /);
    expect(calls[2]?.args[5]).toContain('A案を採用');
  });

  // bdboard-giyt: bdboard-vy0h の逆方向。gate カードへ直接回答したとき、その gate が
  // ブロックしていた work ticket 側の human ラベルも(他に残っている gate が無ければ)
  // 一緒に外れることを押さえる。
  it('clears the human label on the blocked ticket when closing its only open human gate (bdboard-giyt)', async () => {
    const gateId = 'bdboard-gate';
    const ticketId = 'bdboard-task';
    const { runner, calls } = createFakeRunner({
      handler: gateRespondHandler({
        gateId,
        dependents: [
          { id: ticketId, issue_type: 'task', status: 'open', dependency_type: 'blocks' },
        ],
        ticketDependencies: { [ticketId]: [] },
      }),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', gateId, 'A案を採用');

    expect(outcome).toEqual({
      kind: 'gate',
      closed: true,
      clearedHumanLabelTicketIds: [ticketId],
    });
    expect(calls).toEqual([
      {
        command: '/usr/bin/bd',
        args: expectedShowArgs('/my/root', gateId),
        options: { timeoutMs: 5_000 },
      },
      {
        command: '/usr/bin/bd',
        args: expectedGateResponseCommentArgs('/my/root', gateId, 'A案を採用'),
        options: { timeoutMs: 30_000 },
      },
      {
        command: '/usr/bin/bd',
        args: expectedCloseRespondedIssueArgs('/my/root', gateId, 'A案を採用'),
        options: { timeoutMs: 30_000 },
      },
      {
        command: '/usr/bin/bd',
        args: expectedShowWithDependentsArgs('/my/root', gateId),
        options: { timeoutMs: 5_000 },
      },
      {
        command: '/usr/bin/bd',
        args: expectedShowArgs('/my/root', ticketId),
        options: { timeoutMs: 5_000 },
      },
      {
        command: '/usr/bin/bd',
        args: expectedRemoveHumanLabelArgs('/my/root', ticketId),
        options: { timeoutMs: 30_000 },
      },
    ]);
  });

  it('keeps the human label on the blocked ticket when another open human gate still blocks it (bdboard-giyt)', async () => {
    const gateId = 'bdboard-gate-a';
    const ticketId = 'bdboard-task';
    const { runner, calls } = createFakeRunner({
      handler: gateRespondHandler({
        gateId,
        dependents: [
          { id: ticketId, issue_type: 'task', status: 'open', dependency_type: 'blocks' },
        ],
        ticketDependencies: {
          [ticketId]: [
            {
              id: 'bdboard-gate-b',
              issue_type: 'gate',
              await_type: 'human',
              status: 'open',
              dependency_type: 'blocks',
            },
          ],
        },
      }),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', gateId, 'A案を採用');

    expect(outcome).toEqual({ kind: 'gate', closed: true });
    expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
  });

  it('does not remove a blocked ticket label when the post-close dependents lookup fails (fail-soft, bdboard-giyt)', async () => {
    const gateId = 'bdboard-gate';
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show') && args.includes('--include-dependents')) {
          return { stdout: '', stderr: 'database is locked', exitCode: 1 };
        }
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: gateId, issue_type: 'gate' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', gateId, 'A案を採用');

    // The gate itself is already closed successfully (see the earlier calls); a
    // failure reading its dependents must not fail the whole respond() call, and
    // must not falsely report any ticket as cleared.
    expect(outcome).toEqual({ kind: 'gate', closed: true });
    expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
  });

  // bdboard-mw8y: a blocked ticket can itself carry a standalone
  // decision_question (unrelated to the gate that was just answered). Even
  // though no other open human gate blocks it, the gate-side cleanup must not
  // strip the ticket's own pending-decision label out from under it.
  it('keeps the human label on a blocked ticket that carries its own standalone decision_question (bdboard-mw8y)', async () => {
    const gateId = 'bdboard-gate';
    const ticketId = 'bdboard-task';
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          const showIndex = args.indexOf('show');
          const shownId = args[showIndex + 1];
          if (args.includes('--include-dependents')) {
            return {
              stdout: JSON.stringify([
                {
                  id: shownId,
                  issue_type: 'gate',
                  dependents: [
                    { id: ticketId, issue_type: 'task', status: 'open', dependency_type: 'blocks' },
                  ],
                },
              ]),
              stderr: '',
              exitCode: 0,
            };
          }
          if (shownId === gateId) {
            return {
              stdout: JSON.stringify([{ id: shownId, issue_type: 'gate' }]),
              stderr: '',
              exitCode: 0,
            };
          }
          // The blocked ticket itself: no other open human gates block it
          // (dependencies: []), but it carries its own unanswered
          // decision_question in metadata.
          return {
            stdout: JSON.stringify([
              {
                id: shownId,
                issue_type: 'task',
                dependencies: [],
                metadata: { decision_question: 'この場合どうしますか?' },
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', gateId, 'A案を採用');

    expect(outcome).toEqual({ kind: 'gate', closed: true });
    expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
  });

  it('removes the human label for a work ticket without closing it', async () => {
    const issueId = 'bdboard-task';
    const { runner, calls } = createFakeRunner({
      handler: showTaskHandler(issueId),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({ kind: 'ticket', closed: false, resolvedGateIds: [] });
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
    expect(buildTicketResponseCommentBody('A案を採用')).toContain('close はせず');
    // respond の書き込み呼び出し(comment / label remove)は --readonly を付けない。
    // 先頭の show 呼び出しだけは読み取り専用なので --readonly を付ける。
    expect(calls[0]?.args).toContain('--readonly');
    expect(calls[1]?.args).not.toContain('--readonly');
    expect(calls[2]?.args).not.toContain('--readonly');
  });

  it('resolves the one open human gate blocking a work ticket before removing the human label (bdboard-vy0h)', async () => {
    const issueId = 'bdboard-task';
    const { runner, calls } = createFakeRunner({
      handler: showTaskWithDependenciesHandler(issueId, [
        {
          id: 'bdboard-timer-gate',
          issue_type: 'gate',
          await_type: 'timer',
          status: 'open',
          dependency_type: 'blocks',
        },
        {
          id: 'bdboard-human-gate-1',
          issue_type: 'gate',
          await_type: 'human',
          status: 'open',
          dependency_type: 'blocks',
        },
        {
          id: 'bdboard-human-gate-closed',
          issue_type: 'gate',
          await_type: 'human',
          status: 'closed',
          dependency_type: 'blocks',
        },
        {
          id: 'bdboard-discovered-from',
          issue_type: 'task',
          status: 'open',
          dependency_type: 'discovered-from',
        },
      ]),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({
      kind: 'ticket',
      closed: false,
      resolvedGateIds: ['bdboard-human-gate-1'],
    });
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
        args: expectedGateResolveArgs('/my/root', 'bdboard-human-gate-1', 'A案を採用'),
        options: { timeoutMs: 30_000 },
      },
      {
        command: '/usr/bin/bd',
        args: expectedRemoveHumanLabelArgs('/my/root', issueId),
        options: { timeoutMs: 30_000 },
      },
      // bdboard-ixx9: after resolving its one blocking gate, respond() looks up any
      // sibling tickets also blocked by that same gate. The fixture's --include-dependents
      // response has no `dependents` field, so this resolves to an empty list and nothing
      // further happens.
      {
        command: '/usr/bin/bd',
        args: expectedShowWithDependentsArgs('/my/root', 'bdboard-human-gate-1'),
        options: { timeoutMs: 5_000 },
      },
    ]);
    // timer gate, the already-closed human gate, and the non-blocking discovered-from
    // dependency must never be resolved.
    expect(
      calls.some(
        (call) =>
          call.args.includes('gate') &&
          call.args.includes('resolve') &&
          (call.args.includes('bdboard-timer-gate') ||
            call.args.includes('bdboard-human-gate-closed') ||
            call.args.includes('bdboard-discovered-from')),
      ),
    ).toBe(false);
  });

  // bdboard-ixx9: bdboard-giyt (gate->ticket direction) added sibling-ticket cleanup when
  // one gate blocks multiple tickets, but only wired it into the gate-side branch. These
  // three tests cover the ticket-side (ticket->gate direction, bdboard-vy0h/PR#504) branch,
  // which had no such cleanup at all before this fix.
  function ticketRespondHandler(options: {
    readonly issueId: string;
    readonly gateId: string;
    readonly gateDependents?: readonly Record<string, unknown>[];
    readonly siblingShowResponses?: Record<string, Record<string, unknown>>;
  }) {
    return async (_command: string, args: readonly string[]) => {
      if (args.includes('show')) {
        const showIndex = args.indexOf('show');
        const shownId = args[showIndex + 1];
        if (args.includes('--include-dependents')) {
          return {
            stdout: JSON.stringify([
              { id: shownId, issue_type: 'gate', dependents: options.gateDependents ?? [] },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (shownId === options.issueId) {
          return {
            stdout: JSON.stringify([
              {
                id: shownId,
                issue_type: 'task',
                dependencies: [
                  {
                    id: options.gateId,
                    issue_type: 'gate',
                    await_type: 'human',
                    status: 'open',
                    dependency_type: 'blocks',
                  },
                ],
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        const siblingItem = options.siblingShowResponses?.[shownId as string] ?? {
          id: shownId,
          issue_type: 'task',
          dependencies: [],
        };
        return { stdout: JSON.stringify([siblingItem]), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  }

  it('clears a sibling ticket also blocked by the same gate after resolving it via the ticket (bdboard-ixx9)', async () => {
    const issueId = 'bdboard-task-a';
    const gateId = 'bdboard-shared-gate';
    const siblingId = 'bdboard-task-b';
    const { runner, calls } = createFakeRunner({
      handler: ticketRespondHandler({
        issueId,
        gateId,
        gateDependents: [
          { id: issueId, issue_type: 'task', status: 'open', dependency_type: 'blocks' },
          { id: siblingId, issue_type: 'task', status: 'open', dependency_type: 'blocks' },
        ],
      }),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({
      kind: 'ticket',
      closed: false,
      resolvedGateIds: [gateId],
      clearedHumanLabelTicketIds: [siblingId],
    });
    expect(
      calls.some(
        (call) =>
          call.args.includes('label') &&
          call.args.includes('remove') &&
          call.args.includes(siblingId),
      ),
    ).toBe(true);
  });

  it('keeps a sibling ticket label when it is still blocked by another open human gate (bdboard-ixx9)', async () => {
    const issueId = 'bdboard-task-a';
    const gateId = 'bdboard-shared-gate';
    const siblingId = 'bdboard-task-b';
    const { runner, calls } = createFakeRunner({
      handler: ticketRespondHandler({
        issueId,
        gateId,
        gateDependents: [
          { id: issueId, issue_type: 'task', status: 'open', dependency_type: 'blocks' },
          { id: siblingId, issue_type: 'task', status: 'open', dependency_type: 'blocks' },
        ],
        siblingShowResponses: {
          [siblingId]: {
            id: siblingId,
            issue_type: 'task',
            dependencies: [
              {
                id: 'bdboard-other-gate',
                issue_type: 'gate',
                await_type: 'human',
                status: 'open',
                dependency_type: 'blocks',
              },
            ],
          },
        },
      }),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({ kind: 'ticket', closed: false, resolvedGateIds: [gateId] });
    expect(
      calls.some(
        (call) =>
          call.args.includes('label') &&
          call.args.includes('remove') &&
          call.args.includes(siblingId),
      ),
    ).toBe(false);
  });

  // Combines with bdboard-mw8y: a sibling blocked by the same shared gate, but which also
  // carries its own standalone decision_question, must not have that question's label
  // stripped by someone else's answer to the shared gate.
  it('keeps a sibling ticket label when it carries its own standalone decision_question (bdboard-ixx9 + bdboard-mw8y)', async () => {
    const issueId = 'bdboard-task-a';
    const gateId = 'bdboard-shared-gate';
    const siblingId = 'bdboard-task-b';
    const { runner, calls } = createFakeRunner({
      handler: ticketRespondHandler({
        issueId,
        gateId,
        gateDependents: [
          { id: issueId, issue_type: 'task', status: 'open', dependency_type: 'blocks' },
          { id: siblingId, issue_type: 'task', status: 'open', dependency_type: 'blocks' },
        ],
        siblingShowResponses: {
          [siblingId]: {
            id: siblingId,
            issue_type: 'task',
            dependencies: [],
            metadata: { decision_question: '別の質問です' },
          },
        },
      }),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({ kind: 'ticket', closed: false, resolvedGateIds: [gateId] });
    expect(
      calls.some(
        (call) =>
          call.args.includes('label') &&
          call.args.includes('remove') &&
          call.args.includes(siblingId),
      ),
    ).toBe(false);
  });

  it('does not resolve any gate or remove the label when two distinct open human gates block the ticket (bdboard-q1k9)', async () => {
    const issueId = 'bdboard-task';
    const { runner, calls } = createFakeRunner({
      handler: showTaskWithDependenciesHandler(issueId, [
        {
          id: 'bdboard-human-gate-1',
          issue_type: 'gate',
          await_type: 'human',
          status: 'open',
          dependency_type: 'blocks',
        },
        {
          id: 'bdboard-human-gate-2',
          issue_type: 'gate',
          await_type: 'human',
          status: 'open',
          dependency_type: 'blocks',
        },
      ]),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({
      kind: 'ticket',
      closed: false,
      ambiguousGateIds: ['bdboard-human-gate-1', 'bdboard-human-gate-2'],
    });
    // Deliberately does NOT reuse buildResponseCommentBody's kind/count selector here
    // (that would make the assertion self-referential and blind to a wrong '> 1'
    // threshold in the production selector). Instead it builds the expected comment
    // straight from the ambiguous-body builder, so a regression in the selector logic
    // shows up as a call-args mismatch.
    expect(calls).toEqual([
      {
        command: '/usr/bin/bd',
        args: expectedShowArgs('/my/root', issueId),
        options: { timeoutMs: 5_000 },
      },
      {
        command: '/usr/bin/bd',
        args: [
          '-C',
          '/my/root',
          'comment',
          issueId,
          buildTicketAmbiguousGatesResponseCommentBody('A案を採用', [
            'bdboard-human-gate-1',
            'bdboard-human-gate-2',
          ]),
        ],
        options: { timeoutMs: 30_000 },
      },
    ]);
    // Neither gate is resolved and the human label is never touched — the answer is
    // recorded as a comment only, and both tickets stay in the pending-decision lane.
    expect(calls.some((call) => call.args.includes('gate') && call.args.includes('resolve'))).toBe(
      false,
    );
    expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
    expect(
      buildTicketAmbiguousGatesResponseCommentBody('A案を採用', [
        'bdboard-human-gate-1',
        'bdboard-human-gate-2',
      ]),
    ).toContain('どの質問への回答か特定できない');
    // The comment must name the actual blocked gates, not just a count, so the
    // responder knows which cards to open (review finding bdboard-q1k9/PR#513).
    expect(
      buildTicketAmbiguousGatesResponseCommentBody('A案を採用', [
        'bdboard-human-gate-1',
        'bdboard-human-gate-2',
      ]),
    ).toContain('bdboard-human-gate-1');
    expect(
      buildTicketAmbiguousGatesResponseCommentBody('A案を採用', [
        'bdboard-human-gate-1',
        'bdboard-human-gate-2',
      ]),
    ).toContain('bdboard-human-gate-2');
  });

  it('does not remove the label when the single blocking gate resolve fails (bdboard-vy0h)', async () => {
    const issueId = 'bdboard-task';
    const { runner, calls } = createFakeRunner({
      handler: async (_command: string, args: readonly string[]) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              {
                id: issueId,
                issue_type: 'task',
                dependencies: [
                  {
                    id: 'bdboard-human-gate-1',
                    issue_type: 'gate',
                    await_type: 'human',
                    status: 'open',
                    dependency_type: 'blocks',
                  },
                ],
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('gate') && args.includes('resolve')) {
          return { stdout: '', stderr: 'database is locked', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliHumanDecisions(runner);

    await expect(port.respond('/my/root', issueId, 'A案を採用')).rejects.toMatchObject({
      kind: 'lock-contention',
    } satisfies Partial<BdError>);
    // show, comment, then the (failing) gate resolve attempt — no label removal once
    // the gate resolve fails (fail-safe: don't leave the label removed while a
    // blocking gate is still open).
    expect(calls).toHaveLength(3);
    expect(calls[2]?.args).toEqual(
      expectedGateResolveArgs('/my/root', 'bdboard-human-gate-1', 'A案を採用'),
    );
    expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
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

// bdboard-vy0h: resolveKind の kind 判定と、respond() が実際に使う
// blockingHumanGateIds の両方を、同じ 1 回の bd show 呼び出しから正しく取り出せることを
// 直接押さえる。
describe('resolveKindAndBlockingGates', () => {
  it('returns blockingHumanGateIds filtered to open human blocks gates for a ticket', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              {
                id: 'bdboard-probe',
                issue_type: 'task',
                dependencies: [
                  {
                    id: 'bdboard-timer',
                    issue_type: 'gate',
                    await_type: 'timer',
                    status: 'open',
                    dependency_type: 'blocks',
                  },
                  {
                    id: 'bdboard-human-open',
                    issue_type: 'gate',
                    await_type: 'human',
                    status: 'open',
                    dependency_type: 'blocks',
                  },
                ],
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await resolveKindAndBlockingGates(runner, 'bd', '/my/root', 'bdboard-probe');

    expect(result).toEqual({
      kind: 'ticket',
      blockingHumanGateIds: ['bdboard-human-open'],
      hasOwnDecisionQuestion: false,
    });
  });

  it('returns an empty blockingHumanGateIds for a gate (blocking gates are only tracked for tickets)', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: 'bdboard-gate', issue_type: 'gate' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await resolveKindAndBlockingGates(runner, 'bd', '/my/root', 'bdboard-gate');

    expect(result).toEqual({
      kind: 'gate',
      blockingHumanGateIds: [],
      hasOwnDecisionQuestion: false,
    });
  });

  // bdboard-vy0h レビュー指摘: dependencies の形が想定外でも kind 判定を道連れにしない。
  // bdShowItemSchema は dependencies を z.unknown() で受けるので、1件の不正な要素や
  // 配列そのものが壊れていても 'unknown' に倒れるのは kind ではなく該当要素の除外だけで
  // あることを直接押さえる。
  it('keeps kind=ticket and skips only malformed dependency entries when dependencies has an unexpected shape', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              {
                id: 'bdboard-probe',
                issue_type: 'task',
                dependencies: [
                  // bd list --json 由来の生 dependency レコード形(id が無い)。
                  { issue_id: 'bdboard-x', depends_on_id: 'bdboard-y', type: 'parent-child' },
                  null,
                  'not-an-object',
                  {
                    id: 'bdboard-human-open',
                    issue_type: 'gate',
                    await_type: 'human',
                    status: 'open',
                    dependency_type: 'blocks',
                  },
                ],
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await resolveKindAndBlockingGates(runner, 'bd', '/my/root', 'bdboard-probe');

    expect(result).toEqual({
      kind: 'ticket',
      blockingHumanGateIds: ['bdboard-human-open'],
      hasOwnDecisionQuestion: false,
    });
  });

  it('keeps kind=ticket with no blocking gates when dependencies itself is null instead of an array', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              { id: 'bdboard-probe', issue_type: 'task', dependencies: null },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await resolveKindAndBlockingGates(runner, 'bd', '/my/root', 'bdboard-probe');

    expect(result).toEqual({
      kind: 'ticket',
      blockingHumanGateIds: [],
      hasOwnDecisionQuestion: false,
    });
  });

  // dependency_type と issue_type/await_type の条件が独立に効いていることを確認する
  // (bdboard-vy0h レビュー指摘: 既存の discovered-from フィクスチャは issue_type が
  // 'task' で dependency_type 条件だけを単離していなかった)。
  it('excludes an open human gate whose dependency_type is not blocks (e.g. related)', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              {
                id: 'bdboard-probe',
                issue_type: 'task',
                dependencies: [
                  {
                    id: 'bdboard-related-human-gate',
                    issue_type: 'gate',
                    await_type: 'human',
                    status: 'open',
                    dependency_type: 'related',
                  },
                ],
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await resolveKindAndBlockingGates(runner, 'bd', '/my/root', 'bdboard-probe');

    expect(result).toEqual({
      kind: 'ticket',
      blockingHumanGateIds: [],
      hasOwnDecisionQuestion: false,
    });
  });

  // bdboard-mw8y opus レビュー指摘: metadata を bdShowItemSchema へ z.record(z.unknown())
  // として混ぜると、dependencies が避けている「1件の不正で item 全体の safeParse が
  // 失敗し kind 判定まで 'unknown' に道連れにする」失敗モードをこのフィールドだけ
  // 再導入する(bd が metadata: null を返すこと自体は未確認だが、想定外の形が来ても
  // kind 判定へ波及しないという既存の不変条件を守る)。metadata: null でも
  // kind が 'ticket' のまま倒れず、hasOwnDecisionQuestion だけ安全側の false に
  // 倒れることを直接押さえる。
  it('keeps kind=ticket instead of falling to unknown when metadata is null (bdboard-mw8y)', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              { id: 'bdboard-probe', issue_type: 'task', dependencies: [], metadata: null },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await resolveKindAndBlockingGates(runner, 'bd', '/my/root', 'bdboard-probe');

    expect(result).toEqual({
      kind: 'ticket',
      blockingHumanGateIds: [],
      hasOwnDecisionQuestion: false,
    });
  });

  it('reports hasOwnDecisionQuestion true when the ticket carries a non-empty decision_question (bdboard-mw8y)', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              {
                id: 'bdboard-probe',
                issue_type: 'task',
                dependencies: [],
                metadata: { decision_question: 'どちらにしますか?' },
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await resolveKindAndBlockingGates(runner, 'bd', '/my/root', 'bdboard-probe');

    expect(result).toEqual({
      kind: 'ticket',
      blockingHumanGateIds: [],
      hasOwnDecisionQuestion: true,
    });
  });
});

// bdboard-giyt: gate 側 respond() が使う「この gate がブロックしている work ticket」の
// 抽出ロジックを、resolveKindAndBlockingGates と同じ粒度で直接押さえる。
describe('parseShowWithDependentsStdout', () => {
  it('extracts non-closed, blocks-typed, non-gate dependents', () => {
    const stdout = JSON.stringify([
      {
        id: 'bdboard-gate',
        issue_type: 'gate',
        dependents: [
          { id: 'bdboard-open-task', issue_type: 'task', status: 'open', dependency_type: 'blocks' },
          // bdboard-giyt レビュー指摘: 'open' 以外の未終了ステータス(claim 済みの
          // in_progress 等)も、'closed' でない限りは対象に含める。vy0h 側の
          // filterBlockingHumanGateIds がチケットの状態を問わずラベルを外すのと対称。
          {
            id: 'bdboard-in-progress-task',
            issue_type: 'task',
            status: 'in_progress',
            dependency_type: 'blocks',
          },
          {
            id: 'bdboard-closed-task',
            issue_type: 'task',
            status: 'closed',
            dependency_type: 'blocks',
          },
          {
            id: 'bdboard-related-task',
            issue_type: 'task',
            status: 'open',
            dependency_type: 'related',
          },
          {
            id: 'bdboard-other-gate',
            issue_type: 'gate',
            status: 'open',
            dependency_type: 'blocks',
          },
        ],
      },
    ]);

    expect(parseShowWithDependentsStdout(stdout)).toEqual([
      'bdboard-open-task',
      'bdboard-in-progress-task',
    ]);
  });

  it.each([
    ['empty stdout', ''],
    ['invalid JSON', '{not json'],
    ['an empty array', '[]'],
    ['dependents missing', '[{"id":"bdboard-gate","issue_type":"gate"}]'],
    ['dependents not an array', '[{"id":"bdboard-gate","dependents":"nope"}]'],
  ])('returns an empty array for %s', (_label, stdout) => {
    expect(parseShowWithDependentsStdout(stdout)).toEqual([]);
  });

  it('skips only malformed dependent entries without hiding valid ones', () => {
    const stdout = JSON.stringify([
      {
        id: 'bdboard-gate',
        dependents: [
          null,
          'not-an-object',
          { issue_id: 'bdboard-x', depends_on_id: 'bdboard-y' },
          { id: 'bdboard-open-task', issue_type: 'task', status: 'open', dependency_type: 'blocks' },
        ],
      },
    ]);

    expect(parseShowWithDependentsStdout(stdout)).toEqual(['bdboard-open-task']);
  });
});

describe('resolveGateBlockedTicketIds', () => {
  it('returns blocked ticket ids from bd show --include-dependents', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          {
            id: 'bdboard-gate',
            issue_type: 'gate',
            dependents: [
              {
                id: 'bdboard-task',
                issue_type: 'task',
                status: 'open',
                dependency_type: 'blocks',
              },
            ],
          },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const ids = await resolveGateBlockedTicketIds(runner, 'bd', '/my/root', 'bdboard-gate');

    expect(ids).toEqual(['bdboard-task']);
    expect(calls).toEqual([
      {
        command: 'bd',
        args: [
          '--readonly',
          '-C',
          '/my/root',
          'show',
          'bdboard-gate',
          '--json',
          '--include-dependents',
        ],
        options: { timeoutMs: 5_000 },
      },
    ]);
  });

  it('fails soft to an empty array when the show command exits non-zero', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr: 'not found', exitCode: 1 }),
    });

    const ids = await resolveGateBlockedTicketIds(runner, 'bd', '/my/root', 'bdboard-gate');

    expect(ids).toEqual([]);
  });

  it('fails soft to an empty array when the command runner throws', async () => {
    const runner: CommandRunner = {
      async run() {
        throw new Error('boom');
      },
    };

    const ids = await resolveGateBlockedTicketIds(runner, 'bd', '/my/root', 'bdboard-gate');

    expect(ids).toEqual([]);
  });
});
