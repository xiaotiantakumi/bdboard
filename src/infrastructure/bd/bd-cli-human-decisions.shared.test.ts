// bdboard-sso1.84: bd-cli-human-decisions.test.ts の move-only 分割。
// kind (gate/ticket) 判定と bd CLI コマンド実行の共通基盤 (sso1.16 の shared.ts に対応) の
// テストのみを集めている。関数本体・アサーションは分割前から1文字も変えていない。
import { describe, expect, it } from 'vitest';
import {
  parseShowStdoutForKind,
  resolveKind,
  resolveKindAndBlockingGates,
} from './bd-cli-human-decisions.js';
import { createFakeRunner } from './bd-cli-human-decisions-test-support.js';

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
