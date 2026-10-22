import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unrestrictedPlatformSupport } from '../domain/platform-support.js';
import { createLocalFileRoutes } from '../interface/http/local-file-routes.js';
import {
  createFakeLocalFilesCache,
  createFakeLocalFs,
  requestLocal,
} from '../interface/http/local-file-routes-test-support.js';
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
    localFilesRouter: stubRouter('/__sentinel/local-files'),
    homeJudgementRouter: stubRouter('/__sentinel/home'),
    inner: stubRouter('/__sentinel/inner'),
    harnessRouter: stubRouter('/__sentinel/harness'),
    scanRootsRouter: stubRouter('/__sentinel/scan-roots'),
    boardThresholdsRouter: stubRouter('/__sentinel/board-thresholds'),
    dbStatsRouter: stubRouter('/__sentinel/db-stats'),
    aiQuotaAlertRouter: stubRouter('/__sentinel/ai-quota-alert'),
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
      '/__sentinel/local-files',
      '/__sentinel/home',
      '/__sentinel/inner',
      '/__sentinel/harness',
      '/__sentinel/scan-roots',
      '/__sentinel/board-thresholds',
      '/__sentinel/db-stats',
      '/__sentinel/ai-quota-alert',
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
    const localFilesIndex = paths.indexOf('/__sentinel/local-files');
    const homeIndex = paths.indexOf('/__sentinel/home');
    const innerIndex = paths.indexOf('/__sentinel/inner');

    expect(platformSupportIndex).toBeGreaterThanOrEqual(0);
    expect(platformSupportIndex).toBeLessThan(attachmentsIndex);
    expect(attachmentsIndex).toBeLessThan(innerIndex);
    expect(localFilesIndex).toBeGreaterThan(attachmentsIndex);
    expect(localFilesIndex).toBeLessThan(innerIndex);
    expect(homeIndex).toBeGreaterThan(attachmentsIndex);
    expect(homeIndex).toBeLessThan(innerIndex);

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

  it('mounts security headers/auth and compression middleware before every route (bdboard-sso1.14 review 1.1)', () => {
    // mountSecurityMiddleware / createCompressionMiddleware は共に app.use('*', ...)
    // (= method 'ALL', path '/*') として登録される。これが後ろへずれると、認証/CSRF
    // ミドルウェアがそれより前に mount 済みのルートを一切ガードしなくなる
    // (サイレントな認証バイパス)。buildDeps() の security は access 未指定なので
    // tunnel-token-exchange は登録されず、securityHeaders + basicAuth の2本 +
    // compression の1本、計3本の ALL '/*' が期待値。
    const app = new Hono();
    mountRoutes(app, buildDeps());

    const paths = app.routes.map((route) => route.path);
    const platformSupportIndex = paths.indexOf('/api/platform-support');
    expect(platformSupportIndex).toBeGreaterThanOrEqual(0);

    // SPA static fallback (serveStatic) も末尾で app.use('/*', ...) を登録するため
    // method 'ALL' / path '/*' に一致してしまう。先頭 (platform-support より前) の
    // 区間だけを見て、そこに security headers + basic auth + compression の3本が
    // 連続して並んでいることを固定する。この3本が末尾へ動く回帰 (レビューで
    // 実演されたミューテーション) があれば platformSupportIndex が 0 になり、
    // このスライスは空になって toEqual([0, 1, 2]) が落ちる。
    const leadingWildcardIndexes = app.routes
      .slice(0, platformSupportIndex)
      .map((route, index) => ({ route, index }))
      .filter(({ route }) => route.method === 'ALL' && route.path === '/*')
      .map(({ index }) => index);

    expect(leadingWildcardIndexes).toEqual([0, 1, 2]);
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

  it('serves local-files routes instead of the inner ticket catch-all', async () => {
    const fs = createFakeLocalFs();
    fs.addFile('docs/a.md', '# a');
    const cache = createFakeLocalFilesCache({ description: '見る：docs/a.md' });
    const inner = new Hono().get('/api/tickets/:id{.+}', (c) =>
      c.json({ from: 'inner-catch-all' }),
    );
    const app = new Hono();
    mountRoutes(
      app,
      buildDeps({
        security: { authMode: { kind: 'disabled-explicitly' } },
        localFilesRouter: createLocalFileRoutes({ cache, fs }),
        inner,
        staticSpa: undefined,
      }),
    );

    const listed = await requestLocal(app, '/api/tickets/video-1/local-files');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      files: [{ path: 'docs/a.md', kind: 'markdown', size: 3 }],
    });

    const raw = await requestLocal(
      app,
      '/api/tickets/video-1/local-files/raw?path=docs%2Fa.md',
    );
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe('# a');
    expect(raw.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(raw.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');

    const directory = await requestLocal(
      app,
      '/api/tickets/video-1/local-files/list?path=docs',
    );
    expect(directory.status).toBe(200);
    expect(await directory.json()).toMatchObject({ path: 'docs' });

    const caught = await requestLocal(app, '/api/tickets/video-1');
    expect(caught.status).toBe(200);
    expect(await caught.json()).toEqual({ from: 'inner-catch-all' });
  });
});

describe('mountRoutes error handler', () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('answers an error thrown inside a mounted sub-app with the app-level 500 JSON (no stack in the response)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const inner = new Hono().get('/api/throw/:id', () => {
      throw new Error('boom from a handler');
    });
    const app = new Hono();
    mountRoutes(app, buildDeps({ security: { authMode: { kind: 'disabled-explicitly' } }, inner, staticSpa: undefined }));

    const res = await app.request('/api/throw/bdboard-xyz9');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
