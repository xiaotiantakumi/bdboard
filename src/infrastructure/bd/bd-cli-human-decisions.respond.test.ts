// bdboard-sso1.84: bd-cli-human-decisions.test.ts の move-only 分割。
// createBdCliHumanDecisions().respond() と buildGateCloseReason() まわり (回答書き込み、
// sso1.16 の respond.ts / respond-comment.ts / respond-args.ts に対応) のテストのみを
// 集めている。関数本体・アサーションは分割前から1文字も変えていない。
import { describe, expect, it } from 'vitest';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  buildGateCloseReason,
  buildResponseCommentBody,
  buildTicketAmbiguousGatesResponseCommentBody,
  buildTicketOwnQuestionAmbiguousResponseCommentBody,
  buildTicketResponseCommentBody,
  buildUnknownKindResponseCommentBody,
  createBdCliHumanDecisions,
} from './bd-cli-human-decisions.js';
import { createFakeRunner } from './bd-cli-human-decisions-test-support.js';

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

  // bdboard-cine: bdboard-vy0h(1件なら自動resolve)と bdboard-q1k9(2件以上ならambiguous)の
  // 間隙。ちょうど1件の open human gate に blocked されていても、チケット自身が standalone な
  // decision_question を持っていれば、その1件の回答が「gate への回答」なのか「チケット自身の
  // 質問への回答」なのか respond() 側では特定できない。安全側に倒し、gate は resolve せず・
  // human ラベルも外さない(bdboard-q1k9 と同じ ambiguous 分岐に合流させる)。
  it('does not auto-resolve a single unrelated blocking human gate when the ticket carries its own standalone decision_question (bdboard-cine)', async () => {
    const issueId = 'bdboard-task';
    const gateId = 'bdboard-human-gate-1';
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              {
                id: issueId,
                issue_type: 'task',
                dependencies: [
                  {
                    id: gateId,
                    issue_type: 'gate',
                    await_type: 'human',
                    status: 'open',
                    dependency_type: 'blocks',
                  },
                ],
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

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({ kind: 'ticket', closed: false, ambiguousGateIds: [gateId] });
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
          buildTicketOwnQuestionAmbiguousResponseCommentBody('A案を採用', [gateId]),
        ],
        options: { timeoutMs: 30_000 },
      },
    ]);
    expect(calls.some((call) => call.args.includes('gate') && call.args.includes('resolve'))).toBe(
      false,
    );
    expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
    expect(buildTicketOwnQuestionAmbiguousResponseCommentBody('A案を採用', [gateId])).toContain(
      gateId,
    );
  });

  // bdboard-cine: ticket が own decision_question を持っていなければ、ちょうど1件の
  // blocking human gate は従来どおり(bdboard-vy0h)自動で resolve される。
  it('still auto-resolves the single blocking human gate when the ticket has no own decision_question (bdboard-cine regression guard)', async () => {
    const issueId = 'bdboard-task';
    const gateId = 'bdboard-human-gate-1';
    const { runner, calls } = createFakeRunner({
      handler: showTaskWithDependenciesHandler(issueId, [
        {
          id: gateId,
          issue_type: 'gate',
          await_type: 'human',
          status: 'open',
          dependency_type: 'blocks',
        },
      ]),
    });
    const port = createBdCliHumanDecisions(runner, { bdPath: '/usr/bin/bd' });

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({ kind: 'ticket', closed: false, resolvedGateIds: [gateId] });
    expect(calls.some((call) => call.args.includes('gate') && call.args.includes('resolve'))).toBe(
      true,
    );
  });

  // bdboard-cine: a ticket with its own standalone decision_question but zero blocking
  // human gates is the common case for a standalone pending-decision ticket. The
  // `hasOwnDecisionQuestion && blockingHumanGateIds.length >= 1` guard must not misfire
  // here -- otherwise every such ticket would become permanently ambiguous (empty
  // ambiguousGateIds, label never removed) even though there is no gate to disambiguate
  // from.
  it('still resolves normally (label removed, no gate to resolve) when the ticket has its own decision_question but no blocking human gate (bdboard-cine)', async () => {
    const issueId = 'bdboard-task';
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              {
                id: issueId,
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

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({ kind: 'ticket', closed: false, resolvedGateIds: [] });
    expect(
      calls.some((call) => call.args.includes('label') && call.args.includes('remove')),
    ).toBe(true);
    expect(
      calls.some((call) => call.args.includes('gate') && call.args.includes('resolve')),
    ).toBe(false);
  });

  // bdboard-cine: when a ticket has its own decision_question AND 2+ distinct blocking
  // human gates, buildResponseCommentBody's `length > 1` check is evaluated before the
  // own-question check, so the existing multi-gate message (bdboard-q1k9) is used, not
  // the new own-question message. Both are "ambiguous, don't resolve" outcomes either
  // way; this pins the current precedence so a future reordering of the branches is a
  // deliberate choice, not an accident.
  it('uses the multi-gate ambiguous message (not the own-question message) when both apply (bdboard-cine)', async () => {
    const issueId = 'bdboard-task';
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
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
                  {
                    id: 'bdboard-human-gate-2',
                    issue_type: 'gate',
                    await_type: 'human',
                    status: 'open',
                    dependency_type: 'blocks',
                  },
                ],
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

    const outcome = await port.respond('/my/root', issueId, 'A案を採用');

    expect(outcome).toEqual({
      kind: 'ticket',
      closed: false,
      ambiguousGateIds: ['bdboard-human-gate-1', 'bdboard-human-gate-2'],
    });
    expect(calls).toContainEqual({
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
    });
  });

  // bdboard-ixx9: bdboard-giyt (gate->ticket direction) added sibling-ticket cleanup when
  // one gate blocks multiple tickets, but only wired it into the gate-side branch. These
  // three tests cover the ticket-side (ticket->gate direction, bdboard-vy0h/PR#504) branch,
  // which had no such cleanup at all before this fix.
  // Stateful: tracks whether `bd gate resolve <gateId>` has already run, so that a
  // re-`show` of the *answered* ticket (issueId) reflects the gate as closed afterward —
  // matching real bd behavior. This is what lets a test actually exercise the
  // `blockedTicketId !== issueId` self-exclusion guard in the ticket branch: without a
  // stateful mock, issueId's own gate dependency would always read back as still 'open'
  // and get skipped by the ordinary blocking-gate check regardless of that guard, masking
  // a regression where the guard is removed and issueId's own label gets a redundant
  // second `label remove` and incorrectly appears in clearedHumanLabelTicketIds.
  function ticketRespondHandler(options: {
    readonly issueId: string;
    readonly gateId: string;
    readonly gateDependents?: readonly Record<string, unknown>[];
    readonly siblingShowResponses?: Record<string, Record<string, unknown>>;
  }) {
    let gateResolved = false;
    return async (_command: string, args: readonly string[]) => {
      if (args.includes('gate') && args.includes('resolve')) {
        gateResolved = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
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
                    status: gateResolved ? 'closed' : 'open',
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
    // bdboard-ixx9: asserts the `blockedTicketId !== issueId` self-exclusion guard is
    // doing real work, not just satisfying a shape check. issueId's own label was already
    // removed once (unconditionally, before the sibling lookup even runs); without the
    // guard, issueId would also be re-processed as its own "sibling" (the gate's
    // dependents list includes it) and, once the mock reports the just-resolved gate as
    // closed, would get a redundant second `label remove` and wrongly appear in
    // clearedHumanLabelTicketIds above.
    const labelRemoveTargets = calls
      .filter((call) => call.args.includes('label') && call.args.includes('remove'))
      .map((call) => call.args[call.args.length - 2]);
    expect(labelRemoveTargets).toEqual([issueId, siblingId]);
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
