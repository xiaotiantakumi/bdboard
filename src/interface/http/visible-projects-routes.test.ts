import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { createVisibleProjectsRegistry } from '../../application/board/visible-projects-registry.js';
import { LOCAL_ENV, createDeps, withLocalHost } from './routes-test-support.js';

const ERRORS = [
  { kind: 'unknown', projectId: '/p/a', detail: 'dolt server unreachable' },
  { kind: 'unknown', projectId: '/p/b', detail: 'dolt server unreachable' },
];

function put(app: ReturnType<typeof createApiRoutes>, body: unknown, env: unknown = LOCAL_ENV) {
  return app.request(
    '/api/ui/visible-projects',
    withLocalHost({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe('visible projects reporting (bdboard-o1e5)', () => {
  it('shows every status error until a client reports, then only visible ones', async () => {
    const visibleProjects = createVisibleProjectsRegistry();
    const deps = createDeps({
      visibleProjects,
      getStatus: () => ({ lastRefreshAt: null, errors: ERRORS, projectCount: 2 }),
    });
    const app = createApiRoutes(deps);

    const before = await (await app.request('/api/status')).json();
    expect(before.errors).toHaveLength(2);

    const res = await put(app, { clientId: 'tab1', projectIds: ['/p/a'] });
    expect(res.status).toBe(200);

    const after = await (await app.request('/api/status')).json();
    expect(after.errors.map((e: { projectId: string }) => e.projectId)).toEqual(['/p/a']);
  });

  it('refreshes only newly visible projects that are failing', async () => {
    const refreshProjectByRootPath = vi.fn(async () => {});
    const app = createApiRoutes(
      createDeps({
        visibleProjects: createVisibleProjectsRegistry(),
        refreshProjectByRootPath,
        getStatus: () => ({ lastRefreshAt: null, errors: ERRORS, projectCount: 2 }),
      }),
    );
    await put(app, { clientId: 'tab1', projectIds: ['/p/a', '/p/ok'] });
    await put(app, { clientId: 'tab1', projectIds: ['/p/a', '/p/ok'] });
    expect(refreshProjectByRootPath).toHaveBeenCalledTimes(1);
    expect(refreshProjectByRootPath).toHaveBeenCalledWith('/p/a');
  });

  it('rejects a malformed body', async () => {
    const app = createApiRoutes(
      createDeps({ visibleProjects: createVisibleProjectsRegistry() }),
    );
    const res = await put(app, { clientId: '', projectIds: 'x' });
    expect(res.status).toBe(400);
  });

  it('is refused for tunnel (remote) requests like other writes', async () => {
    const app = createApiRoutes(
      createDeps({ visibleProjects: createVisibleProjectsRegistry() }),
    );
    const res = await app.request('/api/ui/visible-projects', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        host: 'example.trycloudflare.com',
        'cf-connecting-ip': '203.0.113.1',
      },
      body: JSON.stringify({ clientId: 'x', projectIds: [] }),
    });
    expect(res.status).toBe(403);
  });
});
