import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { compareStrings } from '../../domain/compare.js';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../../application/ports/board-cache-fakes.js';
import type { HarnessContractReaderPort } from '../../application/ports/harness-contract-reader.js';
import type { HarnessInjectorPort } from '../../application/ports/harness-injector.js';
import type { PackRegistryPort } from '../../application/ports/pack-registry.js';
import type { Project } from '../../domain/project.js';
import { createHarnessRoutes } from './harness-routes.js';

const LOCAL_HOST = 'localhost:8787';

const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: 8787,
    },
  },
};

function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}

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

function createFakeContractReader(options?: {
  readonly contract?: string | null;
  readonly scripts?: readonly string[] | null;
}): HarnessContractReaderPort {
  return {
    readContract: vi.fn(async () => options?.contract ?? null),
    readPackageScripts: vi.fn(async () => options?.scripts ?? null),
  };
}

function createHarnessApp(options?: {
  readonly registry?: PackRegistryPort;
  readonly injector?: HarnessInjectorPort;
  readonly cache?: BoardCache;
  readonly contractReader?: HarnessContractReaderPort;
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
          hooks: [],
        },
      ]),
      getPack: vi.fn(async (name: string) =>
        name === 'bdboard-harness'
          ? {
              name: 'bdboard-harness',
              version: '0.1.0',
              description: 'test pack',
              hooks: [],
              files: [{ relativePath: 'SKILL.md' }],
            }
          : undefined,
      ),
    } satisfies PackRegistryPort);

  const injector: HarnessInjectorPort =
    options?.injector ??
    ({
      readSettings: vi.fn(async () => null),
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
    contractReader: options?.contractReader ?? createFakeContractReader(),
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
        hooks: [],
      },
    ]);
    const registry: PackRegistryPort = {
      listPacks,
      getPack: vi.fn(),
    };

    const injector: HarnessInjectorPort = {
      readSettings: vi.fn(async () => null),
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
              hooksState: 'none-declared',
              missingHooks: [],
            },
          ],
          contract: { state: 'missing' },
        },
        {
          projectId: projB.id,
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.2.0',
              drift: false,
              hooksState: 'none-declared',
              missingHooks: [],
            },
          ],
          contract: { state: 'missing' },
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
      readSettings: vi.fn(async () => null),
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
          hooksState: 'none-declared',
          missingHooks: [],
        },
      ],
      contract: { state: 'missing' },
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
      readSettings: vi.fn(async () => null),
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
      withLocalHost({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pack: 'bdboard-harness' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(injector.injectPack).toHaveBeenCalledWith(
      proj.rootPath,
      expect.objectContaining({ name: 'bdboard-harness' }),
      new Date('2026-08-16T10:00:00.000Z'),
    );
  });

  it('reports contract not-applicable for a project with no injected pack', async () => {
    const cache = createFakeBoardCache();
    const proj = project('/tmp/proj-a', '/tmp/proj-a');
    cache.putProject({ project: proj, tickets: [], fingerprint: 'fp', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });

    const contractReader = createFakeContractReader();
    const app = createHarnessApp({ cache, contractReader });
    const response = await app.request(
      `/api/projects/${encodeURIComponent(proj.id)}/harness`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { contract: unknown };
    expect(body.contract).toEqual({ state: 'not-applicable' });
    expect(contractReader.readContract).not.toHaveBeenCalled();
  });

  it('reports the declared verify command for an injected project', async () => {
    const cache = createFakeBoardCache();
    const proj = project('/tmp/proj-a', '/tmp/proj-a');
    cache.putProject({ project: proj, tickets: [], fingerprint: 'fp', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });

    const injector: HarnessInjectorPort = {
      readSettings: vi.fn(async () => null),
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

    const app = createHarnessApp({
      cache,
      injector,
      contractReader: createFakeContractReader({
        contract: JSON.stringify({
          version: 1,
          verify: 'npm run verify',
          prFlow: 'pr',
          mainBranch: 'main',
        }),
        scripts: ['verify'],
      }),
    });
    const response = await app.request(
      `/api/projects/${encodeURIComponent(proj.id)}/harness`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { contract: unknown };
    expect(body.contract).toEqual({
      state: 'ok',
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: 'main',
    });
  });

  it('reports an invalid contract without failing the request', async () => {
    const cache = createFakeBoardCache();
    const proj = project('/tmp/proj-a', '/tmp/proj-a');
    cache.putProject({ project: proj, tickets: [], fingerprint: 'fp', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });

    const injector: HarnessInjectorPort = {
      readSettings: vi.fn(async () => null),
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

    const app = createHarnessApp({
      cache,
      injector,
      contractReader: createFakeContractReader({ contract: '{ broken' }),
    });
    const response = await app.request(
      `/api/projects/${encodeURIComponent(proj.id)}/harness`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      contract: { state: string; message: string };
    };
    expect(body.contract.state).toBe('invalid');
    expect(body.contract.message).toContain('JSON');
  });

  it('includes the contract state in the inject response without blocking the injection', async () => {
    const cache = createFakeBoardCache();
    const proj = project('/tmp/proj-a', '/tmp/proj-a');
    cache.putProject({ project: proj, tickets: [], fingerprint: 'fp', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });

    const injector: HarnessInjectorPort = {
      readSettings: vi.fn(async () => null),
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

    const app = createHarnessApp({
      cache,
      injector,
      contractReader: createFakeContractReader({ contract: null }),
    });
    const response = await app.request(
      `/api/projects/${encodeURIComponent(proj.id)}/harness/inject`,
      withLocalHost({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pack: 'bdboard-harness' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(injector.injectPack).toHaveBeenCalledTimes(1);
    const body = (await response.json()) as { contract: unknown };
    expect(body.contract).toEqual({ state: 'missing' });
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
      withLocalHost({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pack: 'missing-pack' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(404);
  });

  it('returns 404 when injecting into an unknown project', async () => {
    const app = createHarnessApp();
    const response = await app.request('/api/projects/missing-project/harness/inject', withLocalHost({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pack: 'bdboard-harness' }),
    }), LOCAL_ENV);

    expect(response.status).toBe(404);
  });

  it('returns 500 when injection fails', async () => {
    const cache = createFakeBoardCache();
    const proj = project('/tmp/proj-a', '/tmp/proj-a');
    cache.putProject({ project: proj, tickets: [], fingerprint: 'fp', pendingDecisions: [], fetchedAt: new Date('2026-08-16T00:00:00Z') });

    const injector: HarnessInjectorPort = {
      readSettings: vi.fn(async () => null),
      readManifest: vi.fn(async () => ({ packs: [] })),
      injectPack: vi.fn(async () => {
        throw new Error('disk full');
      }),
    };

    const app = createHarnessApp({ cache, injector });
    const response = await app.request(
      `/api/projects/${encodeURIComponent(proj.id)}/harness/inject`,
      withLocalHost({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pack: 'bdboard-harness' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'injection failed',
      detail: 'disk full',
    });
  });
});
