import { describe, expect, it } from 'vitest';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { ProjectWatchHandle } from '../ports/project-watcher.js';
import type { Project } from '../../domain/project.js';
import { createWatchedProjectsSync } from './sync-watched-projects.js';

function project(id: string, rootPath = `/tmp/${id}`): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: [id],
    aliasPaths: [],
  };
}

function cached(entry: Project): CachedProject {
  return {
    project: entry,
    tickets: [],
    fingerprint: 'fp',
    fetchedAt: new Date('2026-08-15T00:00:00Z'),
  };
}

function fakeCache(projects: Project[]): {
  cache: Pick<BoardCache, 'listProjects'>;
  set(next: Project[]): void;
} {
  let current = projects;
  return {
    cache: {
      listProjects(): readonly CachedProject[] {
        return current.map(cached);
      },
    },
    set(next: Project[]): void {
      current = next;
    },
  };
}

function fakeHandle(): {
  handle: ProjectWatchHandle;
  updates: string[][];
} {
  const updates: string[][] = [];
  return {
    updates,
    handle: {
      async update(projects: readonly Project[]): Promise<void> {
        updates.push(projects.map((entry) => entry.id));
      },
      async stop(): Promise<void> {},
    },
  };
}

describe('createWatchedProjectsSync', () => {
  it('pushes the new project set to the watcher when a project appears', async () => {
    const { cache, set } = fakeCache([project('alpha')]);
    const { handle, updates } = fakeHandle();
    const sync = createWatchedProjectsSync({
      cache,
      handle,
      initialProjects: [project('alpha')],
    });

    set([project('alpha'), project('beta')]);
    const changed = await sync.sync();

    expect(changed).toBe(true);
    expect(updates).toEqual([['alpha', 'beta']]);
  });

  it('pushes the new set when a project disappears', async () => {
    const { cache, set } = fakeCache([project('alpha'), project('beta')]);
    const { handle, updates } = fakeHandle();
    const sync = createWatchedProjectsSync({
      cache,
      handle,
      initialProjects: [project('alpha'), project('beta')],
    });

    set([project('beta')]);
    await sync.sync();

    expect(updates).toEqual([['beta']]);
  });

  it('pushes the new set when a project keeps its id but moves', async () => {
    const { cache, set } = fakeCache([project('alpha', '/tmp/old')]);
    const { handle, updates } = fakeHandle();
    const sync = createWatchedProjectsSync({
      cache,
      handle,
      initialProjects: [project('alpha', '/tmp/old')],
    });

    set([project('alpha', '/tmp/new')]);
    await sync.sync();

    expect(updates).toEqual([['alpha']]);
  });

  it('does nothing while the project set is unchanged', async () => {
    const { cache } = fakeCache([project('alpha'), project('beta')]);
    const { handle, updates } = fakeHandle();
    const sync = createWatchedProjectsSync({
      cache,
      handle,
      initialProjects: [project('beta'), project('alpha')],
    });

    expect(await sync.sync()).toBe(false);
    expect(await sync.sync()).toBe(false);
    expect(updates).toEqual([]);
  });

  it('updates once per change, not once per sync', async () => {
    const { cache, set } = fakeCache([project('alpha')]);
    const { handle, updates } = fakeHandle();
    const sync = createWatchedProjectsSync({
      cache,
      handle,
      initialProjects: [project('alpha')],
    });

    set([project('alpha'), project('beta')]);
    await sync.sync();
    await sync.sync();
    await sync.sync();

    expect(updates).toEqual([['alpha', 'beta']]);
  });

  it('treats an omitted initialProjects as an empty watch set', async () => {
    const { cache } = fakeCache([project('alpha')]);
    const { handle, updates } = fakeHandle();
    const sync = createWatchedProjectsSync({ cache, handle });

    expect(await sync.sync()).toBe(true);
    expect(updates).toEqual([['alpha']]);
  });
});
