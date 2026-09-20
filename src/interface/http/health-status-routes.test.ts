import { describe, expect, it } from 'vitest';
import { createApiRoutes } from './routes.js';
import { NOW, createDeps } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns health payload with ISO now and application version', async () => {
    const deps = createDeps({
      applicationVersion: {
        getVersion: () => '1.2.3',
      },
    });
    const app = createApiRoutes(deps);

    const response = await app.request('/api/health');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, now: NOW.toISOString(), version: '1.2.3' });
  });
  it('includes instanceNonce in health payload when deps provide it', async () => {
    const deps = createDeps({
      applicationVersion: {
        getVersion: () => '1.2.3',
      },
      instanceNonce: 'run-nonce-abc',
    });
    const app = createApiRoutes(deps);

    const response = await app.request('/api/health');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      now: NOW.toISOString(),
      version: '1.2.3',
      instanceNonce: 'run-nonce-abc',
    });
  });
  it('returns status with ISO lastRefreshAt', async () => {
    const deps = createDeps();
    const app = createApiRoutes(deps);

    const response = await app.request('/api/status');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.lastRefreshAt).toBe(NOW.toISOString());
    expect(body.projectCount).toBe(0);
    expect(body.errors).toEqual([]);
    expect(body.boardTimeZone).toBeNull();
  });
});
