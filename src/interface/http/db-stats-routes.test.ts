import { describe, expect, it, vi } from 'vitest';
import type { BoardCache, CacheStats } from '../../application/ports/board-cache.js';
import { createDbStatsRoutes } from './db-stats-routes.js';

function makeCache(stats: CacheStats): BoardCache {
  return {
    getProject: vi.fn(),
    putProject: vi.fn(),
    listProjects: vi.fn(() => []),
    deleteProject: vi.fn(),
    clear: vi.fn(),
    getTranscriptOffset: vi.fn(),
    setTranscriptOffset: vi.fn(),
    addSessionUsage: vi.fn(),
    getSessionUsage: vi.fn(() => []),
    putCfdSnapshot: vi.fn(),
    listCfdSnapshots: vi.fn(() => []),
    getLatestCfdSnapshotDate: vi.fn(),
    pruneCfdSnapshots: vi.fn(() => 0),
    getCacheStats: vi.fn(() => stats),
    upsertSessionLinks: vi.fn(),
    listSessionLinks: vi.fn(() => []),
    appendInteractions: vi.fn(),
    listInteractions: vi.fn(() => []),
    close: vi.fn(),
  };
}

describe('createDbStatsRoutes', () => {
  it('returns cache stats from GET /api/settings/db-stats', async () => {
    const stats: CacheStats = {
      sizeBytes: 12_345,
      tables: [
        { name: 'cfd_snapshots', rowCount: 42 },
        { name: 'projects', rowCount: 3 },
      ],
    };
    const response = await createDbStatsRoutes({
      cache: makeCache(stats),
    }).request('/api/settings/db-stats');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(stats);
  });
});
