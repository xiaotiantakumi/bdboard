// bdboard-sso1.36: agent-run-routes.test.ts (2315行) を #576 の agent-run ルート分割
// (create/read/cancel) に追随して move only 分割したうちの、/api/runs 全体に効く
// リモートガード関連。テスト本体は一字一句変更していない。変更したのは import と、
// 元の describe('createAgentRunRoutes') からリモートブロックの it だけを抽出して
// 包んだ describe('createAgentRunRoutes remote guard') の入れ物のみ (guard mount
// scope の describe は元のタイトルのまま移動)。共有ヘルパーは
// agent-run-routes-test-support.ts へ移した。
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createRunStore, type RunStoreRecord } from '../../application/runner/run-store.js';
import { createAgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import { createAgentRunRoutes } from './agent-run-routes.js';
import {
  NOW,
  LOCAL_ENV,
  CF_HEADER,
  SESSION_COOKIE,
  withRemoteTunnel,
  postRunsInit,
  createFakeBoardCache,
  allowingWriteAccess,
  makeProvisioner,
  makeIssueWriter,
  makeRunner,
  readyHarnessStatus,
  makeRoutes,
  seedOpenTicket,
} from './agent-run-routes-test-support.js';

const EXPECTED_API_RUNS_ROUTES = [
  { method: 'POST', path: '/api/runs' },
  { method: 'GET', path: '/api/runs' },
  { method: 'GET', path: '/api/runs/:runId' },
  { method: 'POST', path: '/api/runs/:runId/cancel' },
] as const;

function collectApiRunsRoutes(app: Hono): Array<{ method: string; path: string }> {
  return app.routes
    .filter(
      (route) =>
        route.path.startsWith('/api/runs') &&
        route.method !== 'ALL' &&
        route.method !== '*',
    )
    .map(({ method, path: routePath }) => ({ method, path: routePath }));
}

function materializeRoutePath(routePath: string): string {
  return routePath.replace(':runId', 'run-x');
}

function requestInitForApiRunsRoute(route: {
  method: string;
  path: string;
}): RequestInit {
  const headers = new Headers({
    ...CF_HEADER,
    Cookie: SESSION_COOKIE,
  });

  if (route.method === 'POST' && route.path === '/api/runs') {
    headers.set('content-type', 'application/json');
    return {
      method: route.method,
      headers,
      body: JSON.stringify({ ticketId: 'bdboard-ok' }),
    };
  }

  return { method: route.method, headers };
}

describe('createAgentRunRoutes remote guard', () => {
  it('blocks all /api/runs routes for remote requests when remote agent runs are disabled', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-ok');

    const dispatch = vi.fn();
    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));

    const runStore = {
      canStart: vi.fn(() => ({ ok: true as const })),
      start: vi.fn(),
      updateCwd: vi.fn(),
      appendChunk: vi.fn(),
      finish: vi.fn(),
      cancel: vi.fn(),
      cancelAll: vi.fn(() => [] as RunStoreRecord[]),
      cancelAllAndWait: vi.fn(async () => {}),
      get: vi.fn(),
      list: vi.fn(() => []),
      getAbortSignal: vi.fn(),
    };

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(),
    });

    const { app } = makeRoutes({
      cache,
      registry,
      runStore,
      worktreeProvisioner,
      writeAccess: allowingWriteAccess(),
      isRemoteAgentRunAllowed: async () => false,
    });

    const routes = collectApiRunsRoutes(app);
    expect(routes.length).toBeGreaterThan(0);

    for (const expected of EXPECTED_API_RUNS_ROUTES) {
      expect(
        routes.some(
          (route) => route.method === expected.method && route.path === expected.path,
        ),
        `expected ${expected.method} ${expected.path} to be registered`,
      ).toBe(true);
    }

    for (const route of routes) {
      const response = await app.request(
        materializeRoutePath(route.path),
        requestInitForApiRunsRoute(route),
        LOCAL_ENV,
      );

      expect(response.status, `${route.method} ${route.path} must be blocked`).toBe(403);
      expect(await response.json()).toEqual({ error: 'remote agent runs are disabled' });
    }

    expect(dispatch).not.toHaveBeenCalled();
    expect(worktreeProvisioner.provision).not.toHaveBeenCalled();
    expect(runStore.canStart).not.toHaveBeenCalled();
    expect(runStore.start).not.toHaveBeenCalled();
    expect(runStore.updateCwd).not.toHaveBeenCalled();
    expect(runStore.appendChunk).not.toHaveBeenCalled();
    expect(runStore.finish).not.toHaveBeenCalled();
    expect(runStore.cancel).not.toHaveBeenCalled();
    expect(runStore.cancelAll).not.toHaveBeenCalled();
    expect(runStore.cancelAllAndWait).not.toHaveBeenCalled();
    expect(runStore.get).not.toHaveBeenCalled();
    expect(runStore.list).not.toHaveBeenCalled();
    expect(runStore.getAbortSignal).not.toHaveBeenCalled();
  });
});

describe('createAgentRunRoutes guard mount scope', () => {
  it('does not leak the agent-run guard onto routes registered after the mount', async () => {
    const parent = new Hono();
    parent.route(
      '/',
      createAgentRunRoutes({
        cache: createFakeBoardCache(),
        registry: createAgentRunnerRegistry(),
        runStore: createRunStore({ now: () => NOW }),
        worktreeProvisioner: makeProvisioner(),
        normalizePath: (pathValue: string) => pathValue,
        writeAccess: allowingWriteAccess(),
        getHarnessStatus: async () => readyHarnessStatus(),
        isRemoteAgentRunAllowed: async () => false,
        now: () => NOW,
        issueWriter: makeIssueWriter(),
      }),
    );
    // main.ts の serveStatic / SPA フォールバックと同じ「後から登録される '*' ハンドラ」
    parent.get('/api/tunnel/status', (c) => c.json({ running: false }));
    parent.get('*', (c) => c.html('<html>spa</html>'));

    for (const path of ['/', '/assets/index.js', '/api/tunnel/status']) {
      const response = await parent.request(path, withRemoteTunnel());
      expect(response.status).toBe(200);
    }

    const guarded = await parent.request(
      '/api/runs',
      withRemoteTunnel(postRunsInit('bdboard-x')),
    );
    expect(guarded.status).toBe(403);
  });
});
