// bdboard-sso1.84: bd-cli-human-decisions.test.ts の move-only 分割。
// createBdCliHumanDecisions().listPendingDecisions() まわり (読み取り、sso1.16 の
// read.ts / read-parse.ts に対応) のテストのみを集めている。関数本体・アサーションは
// 分割前から1文字も変えていない。
import { describe, expect, it } from 'vitest';
import { BdError } from '../../application/ports/issue-repository.js';
import { createBdCliHumanDecisions } from './bd-cli-human-decisions.js';
import { createFakeRunner } from './bd-cli-human-decisions-test-support.js';

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

function isHumanListCall(args: readonly string[]): boolean {
  return args.includes('list') && args.includes('-l') && args.includes('human');
}

function isGateListCall(args: readonly string[]): boolean {
  return args.includes('gate') && args.includes('list');
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
});
