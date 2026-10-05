/** bdboard-4y8q.6.3: refresh result observer の discovery 一覧とキャッシュ prefix。 */
import { describe, expect, it, vi } from 'vitest';
import { createRefreshResultObserver } from './refresh-result-observer.js';
import type { RefreshResult } from './refresh-projects.js';
import { BdError } from '../ports/issue-repository.js';
import type { Project } from '../../domain/project.js';

const discovered: Project = { id: 'found', name: 'found', rootPath: '/found', prefixes: [], aliasPaths: [] };
const cached: Project = { ...discovered, prefixes: ['fnd'] };
const clean: RefreshResult = { refreshed: [], reused: [], removed: [], errors: [] };
const failed: RefreshResult = { ...clean, errors: [new BdError('unknown', 'found', 'failure')] };

describe('createRefreshResultObserver', () => {
  it('passes discovery projects with cached prefixes and preserves never-cached discoveries', async () => {
    const onResult = vi.fn();
    const discovery = { discover: vi.fn().mockResolvedValue([discovered]) };
    const observer = createRefreshResultObserver({ discovery, cache: { listProjects: () => [{ project: { ...discovered, id: 'cached-only' }, tickets: [], fingerprint: '', fetchedAt: new Date() }], listProjectRefs: () => [cached] }, onResult, logError: vi.fn() });
    expect(await observer.discovery.discover()).toEqual([discovered]);
    observer.observe(failed);
    expect(onResult.mock.calls[0]?.[0]).toBe(failed);
    // 一覧は discovery のもの (キャッシュにだけあるプロジェクトは入らず、接頭辞だけキャッシュから合わせる)。
    expect(onResult.mock.calls[0]?.[1]).toEqual([{ ...discovered, prefixes: ['fnd'] }]);
  });

  it('keeps a discovered project whose id is not cached as it is', async () => {
    const onResult = vi.fn();
    const other: Project = { ...discovered, id: 'never-cached', rootPath: '/never-cached' };
    const observer = createRefreshResultObserver({ discovery: { discover: async () => [discovered, other] }, cache: { listProjects: () => [], listProjectRefs: () => [cached] }, onResult, logError: vi.fn() });
    await observer.discovery.discover();
    observer.observe(failed);
    expect(onResult.mock.calls[0]?.[1]).toEqual([{ ...discovered, prefixes: ['fnd'] }, other]);
  });

  it('does not read the cache list for a refresh without errors', async () => {
    const onResult = vi.fn();
    const listProjects = vi.fn(() => []);
    const listProjectRefs = vi.fn(() => [cached]);
    const observer = createRefreshResultObserver({ discovery: { discover: async () => [discovered] }, cache: { listProjects, listProjectRefs }, onResult, logError: vi.fn() });
    await observer.discovery.discover();
    observer.observe(clean);
    // 接頭辞は伏せるときにだけ要る。エラーが無ければ読まず、一覧は discovery のままで渡す。
    expect(listProjects).not.toHaveBeenCalled();
    expect(listProjectRefs).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledExactlyOnceWith(clean, [discovered]);
  });

  it('returns the original discovery when observation is omitted', async () => {
    const discovery = { discover: vi.fn().mockResolvedValue([discovered]) };
    const observer = createRefreshResultObserver({ discovery, cache: { listProjects: () => [] }, logError: vi.fn() });
    expect(observer.discovery).toBe(discovery);
    expect(await observer.discovery.discover()).toEqual([discovered]);
    expect(() => observer.observe(clean)).not.toThrow();
  });

  it('contains callback and cache failures with a fixed log line', async () => {
    const logError = vi.fn();
    const observer = createRefreshResultObserver({ discovery: { discover: async () => [discovered] }, cache: { listProjects: () => { throw new Error('/private'); } }, onResult: vi.fn(), logError });
    await observer.discovery.discover();
    expect(() => observer.observe(failed)).not.toThrow();
    expect(logError).toHaveBeenCalledExactlyOnceWith('Refresh result observer failed');
  });

  it('contains a throwing callback with the same fixed log line', async () => {
    const logError = vi.fn();
    const onResult = vi.fn(() => { throw new Error('/private/secret'); });
    const observer = createRefreshResultObserver({ discovery: { discover: async () => [discovered] }, cache: { listProjects: () => [] }, onResult, logError });
    await observer.discovery.discover();
    expect(() => observer.observe(clean)).not.toThrow();
    expect(logError).toHaveBeenCalledExactlyOnceWith('Refresh result observer failed');
  });
});
