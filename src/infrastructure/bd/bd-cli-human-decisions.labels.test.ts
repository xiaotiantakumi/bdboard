// bdboard-sso1.84: bd-cli-human-decisions.test.ts の move-only 分割。
// human ラベルの掃除 (sso1.16 の labels.ts に対応) のテストのみを集めている。
// 関数本体・アサーションは分割前から1文字も変えていない。
import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import {
  parseShowWithDependentsStdout,
  resolveGateBlockedTicketIds,
} from './bd-cli-human-decisions.js';
import { createFakeRunner } from './bd-cli-human-decisions-test-support.js';

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
