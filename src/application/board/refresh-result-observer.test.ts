/** bdboard-4y8q.6.3: refresh result observer の discovery 一覧とキャッシュ prefix。 */
import { describe, expect, it, vi } from 'vitest';
import { createRefreshResultObserver } from './refresh-result-observer.js';
import type { Project } from '../../domain/project.js';

const discovered: Project = { id: 'found', name: 'found', rootPath: '/found', prefixes: [], aliasPaths: [] };
const cached: Project = { ...discovered, prefixes: ['fnd'] };
const result = { refreshed: [], reused: [], removed: [], errors: [] };

describe('createRefreshResultObserver', () => {
  it('passes discovery projects with cached prefixes and preserves never-cached discoveries', async () => {
    const onResult = vi.fn();
    const discovery = { discover: vi.fn().mockResolvedValue([discovered]) };
    const observer = createRefreshResultObserver({ discovery, cache: { listProjects: () => [{ project: { ...discovered, id: 'cached-only' }, tickets: [], fingerprint: '', fetchedAt: new Date() }], listProjectRefs: () => [cached] }, onResult, logError: vi.fn() });
    expect(await observer.discovery.discover()).toEqual([discovered]);
    observer.observe(result);
    expect(onResult.mock.calls[0]?.[1]).toEqual([{ ...discovered, prefixes: ['fnd'] }]);
  });

  it('returns the original discovery when observation is omitted', async () => {
    const discovery = { discover: vi.fn().mockResolvedValue([discovered]) };
    const observer = createRefreshResultObserver({ discovery, cache: { listProjects: () => [] }, logError: vi.fn() });
    expect(observer.discovery).toBe(discovery);
    expect(await observer.discovery.discover()).toEqual([discovered]);
    observer.observe(result);
  });

  it('contains callback and cache failures with a fixed log line', async () => {
    const logError = vi.fn();
    const observer = createRefreshResultObserver({ discovery: { discover: async () => [discovered] }, cache: { listProjects: () => { throw new Error('/private'); } }, onResult: vi.fn(), logError });
    await observer.discovery.discover();
    expect(() => observer.observe(result)).not.toThrow();
    expect(logError).toHaveBeenCalledExactlyOnceWith('Refresh result observer failed');
  });
});
