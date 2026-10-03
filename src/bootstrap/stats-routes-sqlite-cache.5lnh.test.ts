import { describe, expect, it, vi } from 'vitest';
import type { WorktreeScanner } from '../application/ports/worktree-scanner.js';
import { makeTicket } from '../domain/test-support.js';
import { createSqliteBoardCache } from '../infrastructure/cache/sqlite-board-cache.js';
import { createApiRoutes } from '../interface/http/routes.js';
import { NOW, project, createDeps } from '../interface/http/routes-test-support.js';

// bdboard-5lnh: /api/harness-kpi (誤回収件数用の worktree スキャン前処理を含む) は、
// 以前 stats-routes.ts のスキャン分岐と getHarnessKpi の両方で listProjectsChunked()
// を呼び、全チケットを2回読んでいた。bdboard-mkkx 系のテストと違い壁時計の閾値は
// 使わず、本物の SQLite キャッシュ (createSqliteBoardCache) の各メソッドの呼び出し
// 回数だけで固定する (interface 層は infrastructure を import できないので bootstrap に置く。
// 理由は stats-routes-sqlite-cache.mkkx.test.ts の冒頭を参照)。
describe('/api/harness-kpi + createSqliteBoardCache (bdboard-5lnh)', () => {
  it('reads tickets once (chunked) and projects once (listProjectRefs), never the synchronous listProjects()', async () => {
    const cache = createSqliteBoardCache(':memory:');
    const a = project('proj-a', '/projects/a');
    const b = project('proj-b', '/projects/b');
    for (const proj of [a, b]) {
      cache.putProject({
        project: proj,
        tickets: [makeTicket({ id: `bdboard-${proj.id}`, projectId: proj.id, status: 'open' })],
        fingerprint: `fp-${proj.id}`,
        fetchedAt: NOW,
      });
    }

    const listProjects = vi.spyOn(cache, 'listProjects');
    const listProjectsChunked = vi.spyOn(cache, 'listProjectsChunked' as never);
    const listProjectRefs = vi.spyOn(cache, 'listProjectRefs' as never);
    expect(cache.listProjectsChunked).toBeDefined();
    expect(cache.listProjectRefs).toBeDefined();

    const scan = vi.fn(async () => ({ worktrees: [], bdBranches: [], complete: true }));
    const worktreeScanner: WorktreeScanner = { listChangedFiles: async () => [], scan };

    const app = createApiRoutes(createDeps({ cache, worktreeScanner }));
    const response = await app.request('/api/harness-kpi?weeks=1');

    expect(response.status).toBe(200);
    expect(scan.mock.calls.map((call) => (call as unknown[])[0])).toEqual([a.rootPath, b.rootPath]);
    expect(listProjectRefs).toHaveBeenCalledTimes(1);
    expect(listProjectsChunked).toHaveBeenCalledTimes(1);
    expect(listProjects).not.toHaveBeenCalled();

    // ?projects= narrows the scan targets and the tickets alike.
    scan.mockClear();
    const filtered = await app.request('/api/harness-kpi?weeks=1&projects=proj-b');
    expect(filtered.status).toBe(200);
    expect(scan.mock.calls.map((call) => (call as unknown[])[0])).toEqual([b.rootPath]);

    cache.close();
  });
});
