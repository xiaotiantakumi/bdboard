import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { makeTicket } from '../../domain/test-support.js';
import type { DependencyWriterPort } from '../../application/ports/dependency-writer.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { NOW, LOCAL_ENV, withLocalHost, project, createFakeBoardCache, createDeps } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns 501 when dependency writer port is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'dependency editing not available' });
  });
  it('posts a local dependency add', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({ id: 'bdboard-a', projectId: proj.id }),
        makeTicket({ id: 'bdboard-b', projectId: proj.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(dependencyWriter.addDependency).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'bdboard-b',
    );
  });
  it('deletes a local blocks dependency', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: proj.id,
          dependencies: [
            {
              issueId: 'bdboard-a',
              dependsOnId: 'bdboard-b',
              kind: 'blocks',
            },
          ],
        }),
        makeTicket({ id: 'bdboard-b', projectId: proj.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies/bdboard-b',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(dependencyWriter.removeDependency).toHaveBeenCalledWith(
      '/root/a',
      'bdboard-a',
      'bdboard-b',
    );
  });
  it('returns 403 for dependency POST through tunnel headers', async () => {
    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies',
      withLocalHost({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
    expect(dependencyWriter.addDependency).not.toHaveBeenCalled();
  });
  it('returns 403 for dependency DELETE through tunnel headers', async () => {
    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies/bdboard-b',
      withLocalHost({
        method: 'DELETE',
        headers: {
          'CF-Ray': 'abc123',
        },
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
    expect(dependencyWriter.removeDependency).not.toHaveBeenCalled();
  });
  it('returns 502 with bd detail when dependency add fails', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({ id: 'bdboard-a', projectId: proj.id }),
        makeTicket({ id: 'bdboard-b', projectId: proj.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const circularDetail =
      'error: would create circular dependency: bdboard-a -> bdboard-b';
    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {
        throw new BdError('unknown', 'bdboard-a', circularDetail);
      }),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: 'failed to add dependency',
      detail: circularDetail,
    });
  });
  it('returns 400 when dependency target is in another project', async () => {
    const cache = createFakeBoardCache();
    const projA = project('proj-a', '/root/a');
    const projB = project('proj-b', '/root/b');
    cache.putProject({
      project: projA,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: projA.id })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: projB,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: projB.id })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependsOnId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'dependency target must be in the same project',
    });
    expect(dependencyWriter.addDependency).not.toHaveBeenCalled();
  });
  it('returns 400 when deleting a parent-child dependency', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: proj.id,
          dependencies: [
            {
              issueId: 'bdboard-a',
              dependsOnId: 'bdboard-parent',
              kind: 'parent-child',
            },
          ],
        }),
        makeTicket({ id: 'bdboard-parent', projectId: proj.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies/bdboard-parent',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'only blocks dependencies can be removed',
      kind: 'parent-child',
    });
    expect(dependencyWriter.removeDependency).not.toHaveBeenCalled();
  });
  it('returns 409 without calling bd when the edge is absent from the cache', async () => {
    // 削除ボタンはキャッシュ上の blocks エッジにしか出ない。キャッシュに無いものを
    // 消せてしまうと、stale な間に parent-child を消す事故が起こりうるので弾く。
    const cache = createFakeBoardCache();
    const proj = project('proj-a', '/root/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({ id: 'bdboard-a', projectId: proj.id, dependencies: [] }),
        makeTicket({ id: 'bdboard-b', projectId: proj.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const dependencyWriter: DependencyWriterPort = {
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
    };

    const app = createApiRoutes(createDeps({ cache, dependencyWriter }));
    const response = await app.request(
      '/api/tickets/bdboard-a/dependencies/bdboard-b',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'dependency not found on this ticket',
      id: 'bdboard-a',
      dependsOnId: 'bdboard-b',
    });
    expect(dependencyWriter.removeDependency).not.toHaveBeenCalled();
  });
});
