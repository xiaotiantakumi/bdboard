/**
 * bdboard-4y8q.6.3 (review): wireBoardRefresh hands each refresh result to onRefreshResult exactly once — after the initial refresh
 * and after every refreshRunner run — with the discovery list (not the cache list) joined with the cached prefixes, and a throwing
 * callback does not stop the refresh loop.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RefreshResult } from '../application/board/refresh-projects.js';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { CommandRunner } from '../application/ports/command-runner.js';
import { BdError, type IssueRepository } from '../application/ports/issue-repository.js';
import type { Project } from '../domain/project.js';
import { NodeFileSystem, createSqliteBoardCache } from '../infrastructure/index.js';
import { createEventHub } from '../interface/sse/event-hub.js';
import { wireBoardRefresh } from './wire-board-refresh.js';

const roots: string[] = [];
const caches: BoardCache[] = [];
afterEach(async () => {
  for (const cache of caches.splice(0)) (cache as { close?: () => void }).close?.();
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const noGit: CommandRunner = { run: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 1 }) };

async function setup(onRefreshResult: (result: RefreshResult, projects: readonly Project[]) => void) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-refresh-self-error-')));
  roots.push(root);
  await fs.mkdir(path.join(root, 'never-cached', '.beads'), { recursive: true });
  const cache = createSqliteBoardCache(':memory:');
  caches.push(cache);
  // A project that is never cached (#432): every listAll fails, so the cache never learns it.
  const repository: IssueRepository = {
    listTickets: () => Promise.reject(new Error('unused')),
    listAll: (projects) =>
      Promise.resolve({
        results: [],
        errors: projects.map((project) => new BdError('unknown', project.id, `database "x" not found at ${project.rootPath}`)),
      }),
  };
  const wired = await wireBoardRefresh({
    env: { BDBOARD_SCAN_ROOTS: root },
    fsPort: new NodeFileSystem(),
    commandRunner: noGit,
    scanRootsConfigStore: { read: () => Promise.resolve(undefined), write: () => Promise.resolve() },
    repository,
    cache,
    humanDecisions: { listPendingDecisions: () => Promise.resolve([]), respond: () => Promise.reject(new Error('unused')) },
    events: createEventHub(),
    refreshIntervalMs: 60_000,
    cfdSnapshotIntervalMs: 0,
    cfdSnapshotRetentionDays: 30,
    log: vi.fn(),
    logError: vi.fn(),
    onRefreshResult,
  });
  return { wired, root };
}

describe('wireBoardRefresh onRefreshResult', () => {
  it('is called once for the initial refresh and once per runner run, with the never-cached discovery project', async () => {
    const onRefreshResult = vi.fn();
    const { wired, root } = await setup(onRefreshResult);
    expect(onRefreshResult).toHaveBeenCalledTimes(1);
    const [initialResult, initialProjects] = onRefreshResult.mock.calls[0] as [RefreshResult, readonly Project[]];
    expect(initialResult.errors).toHaveLength(1);
    expect(initialProjects.map((project) => project.rootPath)).toEqual([path.join(root, 'never-cached')]);

    await wired.runRefresh(true);
    expect(onRefreshResult).toHaveBeenCalledTimes(2);
    expect((onRefreshResult.mock.calls[1] as [RefreshResult])[0]).not.toBe(initialResult);
  });

  it('keeps refreshing when the callback throws', async () => {
    const onRefreshResult = vi.fn(() => {
      throw new Error('/private/secret');
    });
    const { wired } = await setup(onRefreshResult);
    await expect(wired.runRefresh(true)).resolves.toBeUndefined();
    await expect(wired.runRefresh(true)).resolves.toBeUndefined();
    expect(onRefreshResult).toHaveBeenCalledTimes(3);
  });
});
