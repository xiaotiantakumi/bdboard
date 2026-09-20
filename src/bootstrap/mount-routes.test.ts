import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { unrestrictedPlatformSupport } from '../domain/platform-support.js';
import { mountRoutes, type MountRoutesDeps } from './mount-routes.js';

/**
 * bdboard-sso1.14: main.ts (第2段) の mount 順ロックダウンテスト。
 *
 * 各ルーターはセンチネル1本だけを持つスタブに差し替える (依存の組み立ては
 * このテストの対象外 — wire-*.ts 側の責務)。分割直前の main.ts
 * (`git show <bdboard-sso1.9 マージコミット>:src/main.ts`) の
 * `const app = new Hono()` 以降の `app.use(` / `app.route(` 出現順を
 * そのまま書き写したものが EXPECTED_MOUNT_ORDER。
 */
function stubRouter(sentinelPath: string): Hono {
  return new Hono().get(sentinelPath, (c) => c.text('ok'));
}

function buildDeps(overrides: Partial<MountRoutesDeps> = {}): MountRoutesDeps {
  return {
    security: { authMode: { kind: 'unconfigured' } },
    platformSupport: unrestrictedPlatformSupport('darwin'),
    attachmentsRouter: stubRouter('/__sentinel/attachments'),
    inner: stubRouter('/__sentinel/inner'),
    harnessRouter: stubRouter('/__sentinel/harness'),
    scanRootsRouter: stubRouter('/__sentinel/scan-roots'),
    boardThresholdsRouter: stubRouter('/__sentinel/board-thresholds'),
    hygieneThresholdsRouter: stubRouter('/__sentinel/hygiene-thresholds'),
    dbStatsRouter: stubRouter('/__sentinel/db-stats'),
    aiQuotaAlertRouter: stubRouter('/__sentinel/ai-quota-alert'),
    agentRunSettingsRouter: stubRouter('/__sentinel/agent-run-settings'),
    agentRunRouter: stubRouter('/__sentinel/agent-run'),
    tunnelRouter: stubRouter('/__sentinel/tunnel'),
    updateCheckRouter: stubRouter('/__sentinel/update-check'),
    aiQuotaRouter: stubRouter('/__sentinel/ai-quota'),
    chatRouter: stubRouter('/__sentinel/chat'),
    staticSpa: { webDistDir: '/tmp/does-not-matter', spaIndexHtml: '<html></html>' },
    ...overrides,
  };
}

describe('mountRoutes order lock-down (bdboard-sso1.14)', () => {
  it('mounts every section in the exact order main.ts used before the split', () => {
    const app = new Hono();
    mountRoutes(app, buildDeps());

    const sentinelGets = app.routes
      .filter((route) => route.method === 'GET' && route.path.startsWith('/__sentinel/'))
      .map((route) => route.path);

    expect(sentinelGets).toEqual([
      '/__sentinel/attachments',
      '/__sentinel/inner',
      '/__sentinel/harness',
      '/__sentinel/scan-roots',
      '/__sentinel/board-thresholds',
      '/__sentinel/hygiene-thresholds',
      '/__sentinel/db-stats',
      '/__sentinel/ai-quota-alert',
      '/__sentinel/agent-run-settings',
      '/__sentinel/agent-run',
      '/__sentinel/tunnel',
      '/__sentinel/update-check',
      '/__sentinel/ai-quota',
      '/__sentinel/chat',
    ]);
  });

  it('omits the ai-quota and chat routers when their deps are undefined (disabled via env)', () => {
    const app = new Hono();
    mountRoutes(app, buildDeps({ aiQuotaRouter: undefined, chatRouter: undefined }));

    const sentinelGets = app.routes
      .filter((route) => route.method === 'GET' && route.path.startsWith('/__sentinel/'))
      .map((route) => route.path);

    expect(sentinelGets).not.toContain('/__sentinel/ai-quota');
    expect(sentinelGets).not.toContain('/__sentinel/chat');
  });

  it('mounts platform-support routes and the processes/chat feature guards before attachments/inner', () => {
    const app = new Hono();
    mountRoutes(app, buildDeps());

    const paths = app.routes.map((route) => route.path);
    const platformSupportIndex = paths.indexOf('/api/platform-support');
    const attachmentsIndex = paths.indexOf('/__sentinel/attachments');
    const innerIndex = paths.indexOf('/__sentinel/inner');

    expect(platformSupportIndex).toBeGreaterThanOrEqual(0);
    expect(platformSupportIndex).toBeLessThan(attachmentsIndex);
    expect(attachmentsIndex).toBeLessThan(innerIndex);

    // processes ガード (collection + wildcard) と chat ガードは ALL メソッドの
    // ミドルウェアとして platform-support routes の直後に登録される。
    const guardRoutes = app.routes.filter(
      (route) =>
        route.method === 'ALL' &&
        (route.path === '/api/processes' ||
          route.path === '/api/processes/*' ||
          route.path === '/api/chat/*'),
    );
    expect(guardRoutes.map((route) => route.path)).toEqual([
      '/api/processes',
      '/api/processes/*',
      '/api/chat/*',
    ]);
  });

  it('serves the SPA static fallback last when provided, and skips it when undefined (API-only mode)', () => {
    const appWithSpa = new Hono();
    mountRoutes(appWithSpa, buildDeps());
    const getAllPaths = appWithSpa.routes
      .filter((route) => route.method === 'GET')
      .map((route) => route.path);
    expect(getAllPaths[getAllPaths.length - 1]).toBe('/*');

    const appApiOnly = new Hono();
    mountRoutes(appApiOnly, buildDeps({ staticSpa: undefined }));
    const apiOnlyGetPaths = appApiOnly.routes
      .filter((route) => route.method === 'GET')
      .map((route) => route.path);
    // wildcard GET はSPAフォールバック専用 (app.use('*', serveStatic) は GET を
    // 登録しない)。API-only モードでは GET '/*' 自体が現れないことを見る。
    expect(apiOnlyGetPaths).not.toContain('/*');
    expect(apiOnlyGetPaths).toContain('/__sentinel/tunnel');
  });
});
