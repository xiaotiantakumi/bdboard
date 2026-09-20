import { describe, expect, it } from 'vitest';
import { createAgentRunRoutes, type AgentRunRoutesDeps } from './agent-run-routes.js';
import { createRunStore } from '../../application/runner/run-store.js';
import { createAgentRunnerRegistry } from '../../application/runner/runner-registry.js';

/**
 * bdboard-sso1.27: agent-run-routes.ts (497行, ミドルウェア4件+ルート4件が同居) を
 * 関心別のルートモジュールへ分割する際の "move only" (挙動変更ゼロ) を保証するための
 * ロックダウンテスト。
 *
 * この配列は、分割着手前の src/interface/http/agent-run-routes.ts
 * (git show <分割直前 HEAD>:src/interface/http/agent-run-routes.ts) に対して実際に
 * `createAgentRunRoutes(...).routes` を呼び出し、返ってきた { method, path } の列を
 * そのまま書き写したもの (分割後のファイル群から再生成していない)。
 *
 * chat-route-order.test.ts (bdboard-sso1.17) と同じ方針で ALL メソッド
 * (app.use によるミドルウェア登録) を除外しない — agentRunGuard は
 * '/api/runs' と '/api/runs/*' の2パターンに、agentRunBodyLimit と rateLimit は
 * '/api/runs' 単独に登録されており、ガードを先に置くことで未認可リクエストが
 * レート制限の枠を消費しないようにしている (agent-run-routes.ts のコメント参照)。
 * この相対順序が変わると挙動が壊れるため、ルートだけでなくミドルウェアも含めた
 * 完全な登録順を固定する。
 */
const EXPECTED_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'ALL', path: '/api/runs' },
  { method: 'ALL', path: '/api/runs/*' },
  { method: 'ALL', path: '/api/runs' },
  { method: 'ALL', path: '/api/runs' },
  { method: 'POST', path: '/api/runs' },
  { method: 'GET', path: '/api/runs' },
  { method: 'GET', path: '/api/runs/:runId' },
  { method: 'POST', path: '/api/runs/:runId/cancel' },
];

function buildMinimalDeps(): AgentRunRoutesDeps {
  // ハンドラは呼ばない (ルート登録の introspection のみ) ので、型を満たす
  // 最低限のスタブで十分。
  return {
    cache: {
      listProjects: () => [],
      getProject: () => undefined,
    } as unknown as AgentRunRoutesDeps['cache'],
    registry: createAgentRunnerRegistry(),
    runStore: createRunStore({ now: () => new Date('2026-01-01T00:00:00Z') }),
    worktreeProvisioner: {} as unknown as AgentRunRoutesDeps['worktreeProvisioner'],
    normalizePath: (pathValue: string) => pathValue,
    getHarnessStatus: async () =>
      ({ packs: [], contract: {} }) as unknown as Awaited<
        ReturnType<AgentRunRoutesDeps['getHarnessStatus']>
      >,
    isRemoteAgentRunAllowed: async () => true,
    now: () => new Date('2026-01-01T00:00:00Z'),
    issueWriter: {} as unknown as AgentRunRoutesDeps['issueWriter'],
  };
}

describe('agent run route order lock-down (bdboard-sso1.27)', () => {
  it('registers exactly the same routes and middleware, in the same order, as the pre-split agent-run-routes.ts', () => {
    const app = createAgentRunRoutes(buildMinimalDeps());

    const actual = app.routes.map((route) => ({ method: route.method, path: route.path }));

    expect(actual).toEqual(EXPECTED_ROUTES);
  });

  it('registers the guard middleware (both patterns) before the body-limit and rate-limit middleware (unauthorized requests must not consume the rate-limit budget)', () => {
    const app = createAgentRunRoutes(buildMinimalDeps());

    const allMiddlewareIndices = app.routes
      .map((route, index) => ({ route, index }))
      .filter(({ route }) => route.method === 'ALL')
      .map(({ index }) => index);

    // index 0/1: agentRunGuard の '/api/runs' + '/api/runs/*'. index 2:
    // agentRunBodyLimit の '/api/runs'. index 3: rateLimit の '/api/runs'.
    expect(allMiddlewareIndices).toEqual([0, 1, 2, 3]);
  });
});
