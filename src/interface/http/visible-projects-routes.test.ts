import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { createVisibleProjectsRegistry } from '../../application/board/visible-projects-registry.js';
import {
  LOCAL_ENV,
  createDeps,
  project,
  seedCache,
  withLocalHost,
} from './routes-test-support.js';

const ERRORS = [
  { kind: 'unknown', projectId: '/p/a', detail: 'dolt server unreachable' },
  { kind: 'unknown', projectId: '/p/b', detail: 'dolt server unreachable' },
  { kind: 'unknown', projectId: '/p/never-cached', detail: 'dolt server unreachable' },
];

function makeApp(overrides: Parameters<typeof createDeps>[0] = {}) {
  const deps = createDeps({
    visibleProjects: createVisibleProjectsRegistry(),
    getStatus: () => ({ lastRefreshAt: null, errors: ERRORS, projectCount: 2 }),
    ...overrides,
  });
  seedCache(deps.cache, [
    { project: project('/p/a', '/p/a'), ticketId: 'a-1' },
    { project: project('/p/b', '/p/b'), ticketId: 'b-1' },
  ]);
  return createApiRoutes(deps);
}

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

async function errorIds(app: ReturnType<typeof createApiRoutes>): Promise<string[]> {
  const body = await (await app.request('/api/status')).json();
  return body.errors.map((e: { projectId: string }) => e.projectId);
}

describe('visible projects reporting (bdboard-o1e5)', () => {
  it('shows every status error until a client reports', async () => {
    const app = makeApp();
    expect(await errorIds(app)).toEqual(['/p/a', '/p/b', '/p/never-cached']);
  });

  it('filters to visible projects but never hides errors of projects that are not cached', async () => {
    const app = makeApp();
    expect((await put(app, { clientId: 'tab1', projectIds: ['/p/a'] })).status).toBe(200);
    expect(await errorIds(app)).toEqual(['/p/a', '/p/never-cached']);
  });

  it('a wildcard report (empty selection) keeps every error visible', async () => {
    const app = makeApp();
    expect((await put(app, { clientId: 'tab1', all: true })).status).toBe(200);
    expect(await errorIds(app)).toEqual(['/p/a', '/p/b', '/p/never-cached']);
  });

  it('never hides every error on an empty cache', async () => {
    const deps = createDeps({
      visibleProjects: createVisibleProjectsRegistry(),
      getStatus: () => ({ lastRefreshAt: null, errors: ERRORS, projectCount: 0 }),
    });
    const app = createApiRoutes(deps);
    await put(app, { clientId: 'tab1', projectIds: ['/p/zzz'] });
    expect(await errorIds(app)).toHaveLength(3);
  });

  it('refreshes newly visible failing projects with a single call', async () => {
    const refreshProjects = vi.fn(async () => {});
    const app = makeApp({ refreshProjects });
    await put(app, { clientId: 'tab1', projectIds: ['/p/a', '/p/b', '/p/ok'] });
    await put(app, { clientId: 'tab1', projectIds: ['/p/a', '/p/b', '/p/ok'] });
    expect(refreshProjects).toHaveBeenCalledTimes(1);
    expect(refreshProjects).toHaveBeenCalledWith(['/p/a', '/p/b']);
  });

  it('a wildcard report also refreshes the failing projects it newly shows', async () => {
    const refreshProjects = vi.fn(async () => {});
    const app = makeApp({ refreshProjects });
    await put(app, { clientId: 'tab1', all: true });
    expect(refreshProjects).toHaveBeenCalledTimes(1);
    expect(refreshProjects).toHaveBeenCalledWith(['/p/a', '/p/b', '/p/never-cached']);
  });

  it('rejects a malformed body', async () => {
    const app = makeApp();
    const res = await put(app, { clientId: '', projectIds: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects an oversized body', async () => {
    const app = makeApp();
    const res = await put(app, { clientId: 'x', projectIds: ['p'.repeat(300_000)] });
    expect(res.status).toBe(413);
  });

  it('is refused for tunnel (remote) requests like other writes', async () => {
    const app = makeApp();
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
