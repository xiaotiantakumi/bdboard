import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { compareStrings } from '../../domain/compare.js';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../../application/ports/board-cache-fakes.js';
import type { HarnessInjectorPort } from '../../application/ports/harness-injector.js';
import type { PackRegistryPort } from '../../application/ports/pack-registry.js';
import type { Project } from '../../domain/project.js';
import { createHarnessRoutes } from './harness-routes.js';

const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
    },
  },
};

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
  const entries = new Map<string, CachedProject>();

  return {
    entries,
    getProject(projectId: string): CachedProject | undefined {
      return entries.get(projectId);
    },
    putProject(entry: CachedProject): void {
      entries.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      entries.delete(projectId);
    },
    clear(): void {
      entries.clear();
    },
    getTranscriptOffset(): number | undefined {
      return undefined;
    },
    setTranscriptOffset(): void {},
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    close(): void {},
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
  };
}

function createHarnessApp(options?: {
  readonly registry?: PackRegistryPort;
  readonly injector?: HarnessInjectorPort;
  readonly cache?: BoardCache;
}): Hono {
  const cache = options?.cache ?? createFakeBoardCache();
  const registry: PackRegistryPort =
    options?.registry ??
    ({
      listPacks: vi.fn(async () => [
        {
          name: 'bdboard-harness',
          version: '0.1.0',
          description: 'test pack',
        },
      ]),
      getPack: vi.fn(async (name: string) =>
        name === 'bdboard-harness'
          ? {
              name: 'bdboard-harness',
              version: '0.1.0',
              description: 'test pack',
              files: [{ relativePath: 'SKILL.md' }],
            }
          : undefined,
      ),
    } satisfies PackRegistryPort);

  const injector: HarnessInjectorPort =
    options?.injector ??
    ({
      readManifest: vi.fn(async () => ({ packs: [] })),
      injectPack: vi.fn(async () => ({
        packs: [
          {
            name: 'bdboard-harness',
            version: '0.1.0',
            injectedAt: '2026-08-16T10:00:00.000Z',
            files: ['.claude/skills/bdboard-harness/SKILL.md'],
          },
        ],
      })),
    } satisfies HarnessInjectorPort);

  return createHarnessRoutes({
    cache,
    registry,
    injector,
    now: () => new Date('2026-08-16T10:00:00.000Z'),
  });
}

describe('createHarnessRoutes', () => {
  it('returns batch harness status for all cached projects', async () => {
    const cache = createFakeBoardCache();
    const projA = project('/tmp/proj-a', '/tmp/proj-a');
    const projB = project('/tmp/proj-b', '/tmp/proj-b');
    cache.putProject({ project: projA, tickets: [], fingerprint: 'fp-a', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });
    cache.putProject({ project: projB, tickets: [], fingerprint: 'fp-b', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });

    const listPacks = vi.fn(async () => [
      {
        name: 'bdboard-harness',
        version: '0.2.0',
        description: 'test pack',
      },
    ]);
    const registry: PackRegistryPort = {
      listPacks,
      getPack: vi.fn(),
    };

    const injector: HarnessInjectorPort = {
      readManifest: vi.fn(async (rootPath: string) => {
        if (rootPath === projA.rootPath) {
          return {
            packs: [
              {
                name: 'bdboard-harness',
                version: '0.1.0',
                injectedAt: '2026-08-16T00:00:00.000Z',
                files: [],
              },
            ],
          };
        }
        return {
          packs: [
            {
              name: 'bdboard-harness',
              version: '0.2.0',
              injectedAt: '2026-08-16T00:00:00.000Z',
              files: [],
            },
          ],
        };
      }),
      injectPack: vi.fn(),
    };

    const app = createHarnessApp({ cache, registry, injector });
    const response = await app.request('/api/harness/status');

    expect(response.status).toBe(200);
    expect(listPacks).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      projects: [
        {
          projectId: projA.id,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.1.0',
              drift: true,
            },
          ],
        },
        {
          projectId: projB.id,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.2.0',
              drift: false,
            },
          ],
        },
      ],
    });
  });

  it('lists available packs', async () => {
    const app = createHarnessApp();
    const response = await app.request('/api/harness/packs');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'test pack',
      },
    ]);
  });

  it('returns project harness status', async () => {
    const cache = createFakeBoardCache();
    const proj = project('/tmp/proj-a', '/tmp/proj-a');
    cache.putProject({ project: proj, tickets: [], fingerprint: 'fp', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });

    const injector: HarnessInjectorPort = {
      readManifest: vi.fn(async () => ({
        packs: [
          {
            name: 'bdboard-harness',
            version: '0.1.0',
            injectedAt: '2026-08-16T00:00:00.000Z',
            files: [],
          },
        ],
      })),
      injectPack: vi.fn(),
    };

    const app = createHarnessApp({ cache, injector });
    const response = await app.request(
      `/api/projects/${encodeURIComponent(proj.id)}/harness`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      packs: [
        {
          name: 'bdboard-harness',
          availableVersion: '0.1.0',
          installedVersion: '0.1.0',
          drift: false,
        },
      ],
    });
  });

  it('returns 404 for unknown project', async () => {
    const app = createHarnessApp();
    const response = await app.request('/api/projects/missing-project/harness');
    expect(response.status).toBe(404);
  });

  it('injects a pack for a known project', async () => {
    const cache = createFakeBoardCache();
    const proj = project('/tmp/proj-a', '/tmp/proj-a');
    cache.putProject({ project: proj, tickets: [], fingerprint: 'fp', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });

    const injector: HarnessInjectorPort = {
      readManifest: vi.fn(async () => ({ packs: [] })),
      injectPack: vi.fn(async () => ({
        packs: [
          {
            name: 'bdboard-harness',
            version: '0.1.0',
            injectedAt: '2026-08-16T10:00:00.000Z',
            files: ['.claude/skills/bdboard-harness/SKILL.md'],
          },
        ],
      })),
    };

    const app = createHarnessApp({ cache, injector });
    const response = await app.request(
      `/api/projects/${encodeURIComponent(proj.id)}/harness/inject`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pack: 'bdboard-harness' }),
      },
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(injector.injectPack).toHaveBeenCalledWith(
      proj.rootPath,
      expect.objectContaining({ name: 'bdboard-harness' }),
      new Date('2026-08-16T10:00:00.000Z'),
    );
  });

  it('returns 404 when injecting an unknown pack', async () => {
    const cache = createFakeBoardCache();
    const proj = project('/tmp/proj-a', '/tmp/proj-a');
    cache.putProject({ project: proj, tickets: [], fingerprint: 'fp', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });

    const registry: PackRegistryPort = {
      listPacks: vi.fn(async () => []),
      getPack: vi.fn(async () => undefined),
    };

    const app = createHarnessApp({ cache, registry });
    const response = await app.request(
      `/api/projects/${encodeURIComponent(proj.id)}/harness/inject`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pack: 'missing-pack' }),
      },
      LOCAL_ENV,
    );

    expect(response.status).toBe(404);
  });

  it('returns 404 when injecting into an unknown project', async () => {
    const app = createHarnessApp();
    const response = await app.request('/api/projects/missing-project/harness/inject', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pack: 'bdboard-harness' }),
    }, LOCAL_ENV);

    expect(response.status).toBe(404);
  });

  it('returns 500 when injection fails', async () => {
    const cache = createFakeBoardCache();
    const proj = project('/tmp/proj-a', '/tmp/proj-a');
    cache.putProject({ project: proj, tickets: [], fingerprint: 'fp', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });

    const injector: HarnessInjectorPort = {
      readManifest: vi.fn(async () => ({ packs: [] })),
      injectPack: vi.fn(async () => {
        throw new Error('disk full');
      }),
    };

    const app = createHarnessApp({ cache, injector });
    const response = await app.request(
      `/api/projects/${encodeURIComponent(proj.id)}/harness/inject`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pack: 'bdboard-harness' }),
      },
      LOCAL_ENV,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'injection failed',
      detail: 'disk full',
    });
  });
});
